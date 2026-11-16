import type { Film, FilmMetadata } from '../types';
import {
  getTmdbMovieMetadata,
  searchTmdbMovie,
  type TmdbSearchResult,
} from './tmdb';

type ScoredResult = {
  result: TmdbSearchResult;
  score: number;
  titleSimilarity: number;
};

type MatchDecision = {
  match: TmdbSearchResult | null;
  ranked: ScoredResult[];
  reason: string;
};

type MatchOverride = {
  releaseYear: number;
  minimumVoteCount: number;
};

// Explicit alternate titles from the TMDB candidates in your logs.
const TITLE_ALIASES: Record<string, string[]> = {
  apursansar: ['the world of apu'],
  nausicaaofthevalleyofthewind: ['warriors of the wind'],
};

// This applies only to a Letterboxd film titled Obsession with year 2025.
const MATCH_OVERRIDES: Record<string, MatchOverride> = {
  'obsession|2025': {
    releaseYear: 2026,
    minimumVoteCount: 5000,
  },
};

function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function getFilmTitleVariants(title: string): string[] {
  const normalizedTitle = normalizeTitle(title);

  return [
    normalizedTitle,
    ...(TITLE_ALIASES[normalizedTitle] ?? []).map(normalizeTitle),
  ];
}

function getReleaseYear(releaseDate: string): number | null {
  const match = /^(\d{4})/.exec(releaseDate);
  if (!match) return null;

  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

function getSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftChars = [...left];
  const rightChars = [...right];

  let previousRow = Array.from(
    { length: rightChars.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
    const currentRow = [leftIndex];

    for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
      const substitutionCost =
        leftChars[leftIndex - 1] === rightChars[rightIndex - 1] ? 0 : 1;

      currentRow[rightIndex] = Math.min(
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );
    }

    previousRow = currentRow;
  }

  const distance = previousRow[rightChars.length];
  return 1 - distance / Math.max(leftChars.length, rightChars.length);
}

function scoreCandidate(film: Film, result: TmdbSearchResult): ScoredResult {
  const sourceTitles = getFilmTitleVariants(film.title);
  const resultTitles = [
    normalizeTitle(result.title),
    normalizeTitle(result.original_title),
  ];

  const titleSimilarity = Math.max(
    0,
    ...sourceTitles.flatMap((sourceTitle) =>
      resultTitles.map((resultTitle) =>
        getSimilarity(sourceTitle, resultTitle),
      ),
    ),
  );

  if (film.year === null) {
    return {
      result,
      titleSimilarity,
      score: titleSimilarity,
    };
  }

  const resultYear = getReleaseYear(result.release_date);
  let yearScore = 0.5;

  if (resultYear !== null) {
    const difference = Math.abs(film.year - resultYear);

    if (difference === 0) yearScore = 1;
    else if (difference === 1) yearScore = 0.65;
    else if (difference === 2) yearScore = 0.35;
    else yearScore = 0;
  }

  return {
    result,
    titleSimilarity,
    score: titleSimilarity * 0.78 + yearScore * 0.22,
  };
}

function rankResults(
  film: Film,
  results: TmdbSearchResult[],
): ScoredResult[] {
  const uniqueResults = new Map<number, TmdbSearchResult>();

  for (const result of results) {
    uniqueResults.set(result.id, result);
  }

  return [...uniqueResults.values()]
    .map((result) => scoreCandidate(film, result))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.result.vote_count ?? 0) - (a.result.vote_count ?? 0) ||
        (b.result.popularity ?? 0) - (a.result.popularity ?? 0) ||
        a.result.id - b.result.id,
    );
}

function decideMatch(film: Film, results: TmdbSearchResult[]): MatchDecision {
  const ranked = rankResults(film, results);
  const best = ranked[0];

  if (!best) {
    return {
      match: null,
      ranked,
      reason: 'TMDB returned no candidates.',
    };
  }

  const runnerUp = ranked[1];
  const secondBestScore = runnerUp?.score ?? 0;
  const scoreMargin = best.score - secondBestScore;

  const minimumTitleSimilarity = film.year === null ? 0.97 : 0.9;
  const minimumScore = film.year === null ? 0.96 : 0.88;
  const minimumMargin = 0.06;

  if (best.titleSimilarity < minimumTitleSimilarity) {
    return {
      match: null,
      ranked,
      reason: `Best title similarity was ${best.titleSimilarity.toFixed(3)}; needs ${minimumTitleSimilarity}.`,
    };
  }

  if (best.score < minimumScore) {
    return {
      match: null,
      ranked,
      reason: `Best overall score was ${best.score.toFixed(3)}; needs ${minimumScore}.`,
    };
  }

  const exactTitleAndYear =
    film.year !== null &&
    getReleaseYear(best.result.release_date) === film.year &&
    best.titleSimilarity >= 0.99;

  const bestVoteCount = best.result.vote_count ?? 0;
  const secondVoteCount = runnerUp?.result.vote_count ?? 0;

  const decisiveVoteLead =
    exactTitleAndYear &&
    bestVoteCount >= 50 &&
    bestVoteCount >= Math.max(1, secondVoteCount) * 3;

  if (scoreMargin < minimumMargin && !decisiveVoteLead) {
    return {
      match: null,
      ranked,
      reason: `Top candidates were close: margin ${scoreMargin.toFixed(3)}; needs ${minimumMargin}, or a decisive vote-count lead.`,
    };
  }

  return {
    match: best.result,
    ranked,
    reason: 'Confident match.',
  };
}

function getOverrideKey(film: Film): string {
  return `${normalizeTitle(film.title)}|${film.year ?? ''}`;
}

function findOverrideMatch(
  film: Film,
  results: TmdbSearchResult[],
): TmdbSearchResult | null | undefined {
  const override = MATCH_OVERRIDES[getOverrideKey(film)];

  // undefined means this film has no explicit override.
  if (!override) return undefined;

  const sourceTitles = getFilmTitleVariants(film.title);

  const overrideCandidates = results.filter((result) => {
    const hasPreferredYear =
      getReleaseYear(result.release_date) === override.releaseYear;

    const titleMatches = [
      normalizeTitle(result.title),
      normalizeTitle(result.original_title),
    ].some((resultTitle) => sourceTitles.includes(resultTitle));

    const hasEnoughVotes =
      (result.vote_count ?? 0) >= override.minimumVoteCount;

    return hasPreferredYear && titleMatches && hasEnoughVotes;
  });

  return (
    overrideCandidates.sort(
      (a, b) =>
        (b.vote_count ?? 0) - (a.vote_count ?? 0) ||
        (b.popularity ?? 0) - (a.popularity ?? 0),
    )[0] ?? null
  );
}

function logManualReview(
  film: Film,
  decision: MatchDecision,
  yearSearchCount: number,
  broaderSearchCount: number,
) {
  console.warn('[TMDB manual-review]', {
    film: film.title,
    year: film.year,
    reason: decision.reason,
    yearSearchResults: yearSearchCount,
    broaderSearchResults: broaderSearchCount,
    topCandidates: decision.ranked.slice(0, 4).map((candidate) => ({
      id: candidate.result.id,
      title: candidate.result.title,
      originalTitle: candidate.result.original_title,
      year: getReleaseYear(candidate.result.release_date),
      score: Number(candidate.score.toFixed(3)),
      titleSimilarity: Number(candidate.titleSimilarity.toFixed(3)),
      voteCount: candidate.result.vote_count ?? 0,
      popularity: candidate.result.popularity ?? 0,
    })),
  });
}

export async function findFilmMetadata(
  film: Film,
): Promise<FilmMetadata | null> {
  if (film.metadata?.tmdbId) {
    if (film.metadata.posterPath !== undefined) {
      return film.metadata;
    }

    return getTmdbMovieMetadata(film.metadata.tmdbId);
  }

  const yearFilteredResults = await searchTmdbMovie(film.title, film.year);
  let results = yearFilteredResults;
  let broaderSearchCount = 0;

  const override = MATCH_OVERRIDES[getOverrideKey(film)];

  if (override) {
    const broaderResults = await searchTmdbMovie(film.title, null);
    broaderSearchCount = broaderResults.length;
    results = [...yearFilteredResults, ...broaderResults];

    const overrideMatch = findOverrideMatch(film, results);

    if (overrideMatch) {
      return getTmdbMovieMetadata(overrideMatch.id);
    }

    const decision = decideMatch(film, results);
    logManualReview(
      film,
      {
        ...decision,
        match: null,
        reason: `The ${override.releaseYear} override candidate was not found with at least ${override.minimumVoteCount} TMDB votes.`,
      },
      yearFilteredResults.length,
      broaderSearchCount,
    );

    return null;
  }

  let decision = decideMatch(film, results);

  if (!decision.match && film.year !== null) {
    const broaderResults = await searchTmdbMovie(film.title, null);
    broaderSearchCount = broaderResults.length;
    results = [...yearFilteredResults, ...broaderResults];
    decision = decideMatch(film, results);
  }

  if (!decision.match) {
    logManualReview(
      film,
      decision,
      yearFilteredResults.length,
      broaderSearchCount,
    );
    return null;
  }

  return getTmdbMovieMetadata(decision.match.id);
}