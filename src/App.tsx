import { useEffect, useState, type ChangeEvent } from 'react';
import type { Film } from './types';
import { readLetterboxdZip } from './lib/readLetterboxdZip';
import { parseLetterboxd } from './lib/parseLetterboxd';
import { loadLibrary, saveLibrary } from './lib/libraryStorage';
import {
  getAvailableYears,
  getFilmsForPeriod,
  getPeriodWatchCount,
} from './lib/stats';
import { findFilmMetadata } from './lib/enrichFilm';
import {
  getTmdbMovieMetadata,
  searchTmdbMovie,
  type TmdbSearchResult,
} from './lib/tmdb';
import { WorldMap } from './components/WorldMap';
import './App.css';

type FilmSort = 'title' | 'rating-high' | 'rating-low' | 'year-new' | 'year-old';
type TasteMode = 'most-watched' | 'highest-rated';
type CastMode = 'most-watched' | 'highest-rated';
type DirectorMode = 'most-watched' | 'highest-rated';
type YearChartMode = 'films' | 'ratings' | 'diary';

const spectrumHeights = [
  34, 58, 25, 73, 45, 91, 30, 62, 42, 77, 35, 57, 28, 68, 38, 82, 44, 61, 32,
  72, 27, 55, 39, 66, 30, 78, 48, 59,
];

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

const languageDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });

function getLanguageLabel(code: string | null | undefined): string {
  if (!code) return '';
  if (code.toLowerCase() === 'xx') return 'No spoken language';
  return languageDisplayNames.of(code) ?? code.toUpperCase();
}

function App() {
  const [films, setFilms] = useState<Film[]>([]);
  const [status, setStatus] = useState(
    'Looking for a library saved on this device…',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'review' | 'films'
  >('dashboard');
  const [period, setPeriod] = useState(
    () => String(new Date().getFullYear()),
  );
  const [reviewFilmMode, setReviewFilmMode] = useState<'year' | 'older'>('year');
  const [yearChartMode, setYearChartMode] = useState<YearChartMode>('films');
  const [tasteMode, setTasteMode] = useState<TasteMode>('most-watched');
  const [castMode, setCastMode] = useState<CastMode>('most-watched');
  const [castVisibleCount, setCastVisibleCount] = useState(10);
  const [directorMode, setDirectorMode] = useState<DirectorMode>('most-watched');
  const [directorVisibleCount, setDirectorVisibleCount] = useState(10);

  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState('');
  const [enrichMessage, setEnrichMessage] = useState('');
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [enrichStats, setEnrichStats] = useState({
    completed: 0,
    total: 0,
    etaSeconds: null as number | null,
  });
  const [enrichElapsedSeconds, setEnrichElapsedSeconds] = useState(0);

  const [manualSearchResults, setManualSearchResults] = useState<
    Record<string, TmdbSearchResult[]>
  >({});
  const [manualBusyKey, setManualBusyKey] = useState<string | null>(null);
  const [manualMessage, setManualMessage] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const [filmSearch, setFilmSearch] = useState('');
  const [genreFilter, setGenreFilter] = useState('all');
  const [directorFilter, setDirectorFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [scoreFilter, setScoreFilter] = useState('all');
  const [filmSort, setFilmSort] = useState<FilmSort>('title');

  useEffect(() => {
    let cancelled = false;

    loadLibrary()
      .then((savedFilms) => {
        if (cancelled) return;

        setFilms(savedFilms);
        setStatus(
          savedFilms.length
            ? `Restored ${savedFilms.length} titles from this device.`
            : 'No saved library yet. Import an export to begin.',
        );

        const availableYears = getAvailableYears(savedFilms);
        const currentYear = String(new Date().getFullYear());

        setPeriod(
          availableYears.includes(currentYear)
            ? currentYear
            : availableYears[0] ?? 'all-time',
        );
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('Could not load a saved library from this browser.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enrichBusy) return;

    const timer = window.setInterval(() => {
      setEnrichElapsedSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [enrichBusy]);

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';

    if (!file) return;

    setBusy(true);
    setError(null);
    setStatus(`Reading ${file.name}…`);

    try {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        throw new Error('Choose a Letterboxd ZIP export.');
      }

      const rows = await readLetterboxdZip(file);
      const importedFilms: Film[] = parseLetterboxd(rows);

      if (importedFilms.length === 0) {
        throw new Error('No films were found in that file.');
      }

      setFilms(importedFilms);
      setManualSearchResults({});
      setManualMessage('');
      setManualError(null);

      const availableYears = getAvailableYears(importedFilms);
      const currentYear = String(new Date().getFullYear());

      setPeriod(
        availableYears.includes(currentYear)
          ? currentYear
          : availableYears[0] ?? 'all-time',
      );

      try {
        await saveLibrary(importedFilms);
        setStatus(
          `Imported and saved ${importedFilms.length} titles on this device.`,
        );
      } catch {
        setStatus(
          `Imported ${importedFilms.length} titles, but could not save them.`,
        );
        setError(
          'The library is available until you close or refresh this page.',
        );
      }

      await enrichLibrary(importedFilms);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not import this file.',
      );
      setStatus('Import failed.');
    } finally {
      setBusy(false);
    }
  }

  async function enrichLibrary(sourceFilms: Film[] = films) {
    const candidates = sourceFilms.filter(
      (film) =>
        (film.watched || film.rating !== null) &&
        (!film.metadata?.tmdbId ||
          film.metadata.posterPath === undefined ||
          !film.metadata.originalLanguage ||
          !film.metadata.cast ||
          !film.metadata.directorProfiles ||
          typeof film.metadata.tmdbRating !== 'number' ||
          typeof film.metadata.tmdbVoteCount !== 'number' ||
          typeof film.metadata.tmdbPopularity !== 'number' ||
          film.metadata.releaseDate === undefined),
    );

    if (candidates.length === 0) {
      setEnrichStats({ completed: 0, total: 0, etaSeconds: null });
      setEnrichMessage(
        'All watched and rated films already have TMDB metadata.',
      );
      setEnrichError(null);
      return;
    }

    setEnrichBusy(true);
    setEnrichError(null);
    setEnrichMessage('');
    setEnrichElapsedSeconds(0);
    setEnrichStats({
      completed: 0,
      total: candidates.length,
      etaSeconds: null,
    });

    const startedAt = Date.now();
    const updatedFilms = [...sourceFilms];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let completedCount = 0;

    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const film = candidates[index];

        setEnrichProgress(
          `Checking film ${index + 1} of ${candidates.length}: ${film.title}`,
        );

        const metadata = film.metadata?.tmdbId
          ? await getTmdbMovieMetadata(film.metadata.tmdbId)
          : await findFilmMetadata(film);

        if (metadata) {
          const filmIndex = updatedFilms.findIndex(
            (item) => item.key === film.key,
          );

          if (filmIndex !== -1) {
            updatedFilms[filmIndex] = {
              ...updatedFilms[filmIndex],
              metadata,
            };
            matchedCount += 1;
          }
        } else {
          unmatchedCount += 1;
        }

        completedCount += 1;

        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        const averageSecondsPerFilm = elapsedSeconds / completedCount;
        const remainingFilms = candidates.length - completedCount;
        const etaSeconds = Math.ceil(
          averageSecondsPerFilm * remainingFilms,
        );

        setEnrichStats({
          completed: completedCount,
          total: candidates.length,
          etaSeconds,
        });

        const isCheckpoint = completedCount % 10 === 0;
        const isLastFilm = completedCount === candidates.length;

        if (isCheckpoint || isLastFilm) {
          const snapshot = [...updatedFilms];
          setFilms(snapshot);
          await saveLibrary(snapshot);
        }
      }

      setEnrichProgress('');
      setEnrichMessage(
        `Finished: ${matchedCount} matched, ${unmatchedCount} need a manual match.`,
      );
    } catch (reason) {
      const snapshot = [...updatedFilms];
      setFilms(snapshot);

      try {
        await saveLibrary(snapshot);
      } catch {
        // Keep the lookup error visible; successful metadata remains in memory.
      }

      setEnrichProgress('');
      setEnrichError(
        reason instanceof Error
          ? reason.message
          : 'TMDB lookup stopped unexpectedly.',
      );
    } finally {
      setEnrichBusy(false);
    }
  }

  async function searchManualMatches(film: Film) {
    setManualBusyKey(film.key);
    setManualError(null);
    setManualMessage('');

    try {
      const results = await searchTmdbMovie(film.title, film.year);
      setManualSearchResults((current) => ({
        ...current,
        [film.key]: results.slice(0, 8),
      }));
    } catch (reason) {
      setManualError(
        reason instanceof Error
          ? reason.message
          : `Could not search for ${film.title}.`,
      );
    } finally {
      setManualBusyKey(null);
    }
  }

  async function saveManualMatch(film: Film, match: TmdbSearchResult) {
    setManualBusyKey(film.key);
    setManualError(null);
    setManualMessage('');

    try {
      const metadata = await getTmdbMovieMetadata(match.id);
      const updatedFilms = films.map((item) =>
        item.key === film.key ? { ...item, metadata } : item,
      );

      await saveLibrary(updatedFilms);
      setFilms(updatedFilms);

      setManualSearchResults((current) => {
        const updated = { ...current };
        delete updated[film.key];
        return updated;
      });

      const year = match.release_date
        ? ` (${match.release_date.slice(0, 4)})`
        : '';

      setManualMessage(`Saved TMDB match: ${match.title}${year}.`);
    } catch (reason) {
      setManualError(
        reason instanceof Error
          ? reason.message
          : `Could not save the match for ${film.title}.`,
      );
    } finally {
      setManualBusyKey(null);
    }
  }

  const years = getAvailableYears(films);

  const unmatchedFilms = films.filter(
    (film) =>
      (film.watched || film.rating !== null) && !film.metadata?.tmdbId,
  );

  const filmCollection = films.filter(
    (film) => film.watched || film.rating !== null,
  );

  const filmGenres = [
    ...new Set(filmCollection.flatMap((film) => film.metadata?.genres ?? [])),
  ].sort((a, b) => a.localeCompare(b));

  const filmDirectors = [
    ...new Set(
      filmCollection.flatMap((film) => film.metadata?.directors ?? []),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const filmCountries = [
    ...new Set(
      filmCollection.flatMap((film) => film.metadata?.countries ?? []),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const filmScores = [
    ...new Set(
      filmCollection
        .map((film) => film.rating)
        .filter((rating): rating is number => rating !== null),
    ),
  ].sort((a, b) => b - a);

  const searchTerm = filmSearch.trim().toLocaleLowerCase();

  const visibleFilms = filmCollection
    .filter((film) => {
      const metadata = film.metadata;
      const searchableText = [
        film.title,
        film.year?.toString() ?? '',
        ...(metadata?.genres ?? []),
        ...(metadata?.directors ?? []),
        ...(metadata?.countries ?? []),
      ]
        .join(' ')
        .toLocaleLowerCase();

      return (
        (searchTerm === '' || searchableText.includes(searchTerm)) &&
        (genreFilter === 'all' ||
          (metadata?.genres ?? []).includes(genreFilter)) &&
        (directorFilter === 'all' ||
          (metadata?.directors ?? []).includes(directorFilter)) &&
        (countryFilter === 'all' ||
          (metadata?.countries ?? []).includes(countryFilter)) &&
        (scoreFilter === 'all' ||
          (scoreFilter === 'unrated'
            ? film.rating === null
            : film.rating === Number(scoreFilter)))
      );
    })
    .sort((a, b) => {
      switch (filmSort) {
        case 'rating-high':
          return (b.rating ?? -1) - (a.rating ?? -1);
        case 'rating-low':
          return (a.rating ?? Infinity) - (b.rating ?? Infinity);
        case 'year-new':
          return (b.year ?? -Infinity) - (a.year ?? -Infinity);
        case 'year-old':
          return (a.year ?? Infinity) - (b.year ?? Infinity);
        default:
          return a.title.localeCompare(b.title);
      }
    });

  const periodFilms = getFilmsForPeriod(films, period);
  const castTotals = new Map<
    number,
    {
      id: number;
      name: string;
      profilePath: string | null;
      filmCount: number;
      ratingTotal: number;
      ratedFilmCount: number;
    }
  >();

  for (const film of periodFilms) {
    const seenCastIds = new Set<number>();

    for (const person of film.metadata?.cast ?? []) {
      if (seenCastIds.has(person.id)) continue;
      seenCastIds.add(person.id);

      const current = castTotals.get(person.id) ?? {
        id: person.id,
        name: person.name,
        profilePath: person.profilePath,
        filmCount: 0,
        ratingTotal: 0,
        ratedFilmCount: 0,
      };
      current.filmCount += 1;

      if (film.rating !== null) {
        current.ratingTotal += film.rating;
        current.ratedFilmCount += 1;
      }

      castTotals.set(person.id, current);
    }
  }

  const castMembers = [...castTotals.values()]
    .map((person) => ({
      ...person,
      averageRating:
        person.ratedFilmCount > 0
          ? person.ratingTotal / person.ratedFilmCount
          : 0,
    }))
    .filter((person) =>
      castMode === 'most-watched'
        ? person.filmCount >= 2
        : person.ratedFilmCount >= 2,
    )
    .sort((a, b) =>
      castMode === 'most-watched'
        ? b.filmCount - a.filmCount || a.name.localeCompare(b.name)
        : b.averageRating - a.averageRating ||
          b.ratedFilmCount - a.ratedFilmCount ||
          a.name.localeCompare(b.name),
    );
const visibleCastMembers = castMembers.slice(0, castVisibleCount);

  const directorTotals = new Map<
    number,
    {
      id: number;
      name: string;
      profilePath: string | null;
      filmCount: number;
      ratingTotal: number;
      ratedFilmCount: number;
    }
  >();

  for (const film of periodFilms) {
    const seenDirectorIds = new Set<number>();

    for (const director of film.metadata?.directorProfiles ?? []) {
      if (seenDirectorIds.has(director.id)) continue;
      seenDirectorIds.add(director.id);

      const current = directorTotals.get(director.id) ?? {
        id: director.id,
        name: director.name,
        profilePath: director.profilePath,
        filmCount: 0,
        ratingTotal: 0,
        ratedFilmCount: 0,
      };
      current.filmCount += 1;

      if (film.rating !== null) {
        current.ratingTotal += film.rating;
        current.ratedFilmCount += 1;
      }

      directorTotals.set(director.id, current);
    }
  }

  const directors = [...directorTotals.values()]
    .map((director) => ({
      ...director,
      averageRating:
        director.ratedFilmCount > 0
          ? director.ratingTotal / director.ratedFilmCount
          : 0,
    }))
    .filter((director) =>
      directorMode === 'most-watched'
        ? director.filmCount >= 2
        : director.ratedFilmCount >= 2,
    )
    .sort((a, b) =>
      directorMode === 'most-watched'
        ? b.filmCount - a.filmCount || a.name.localeCompare(b.name)
        : b.averageRating - a.averageRating ||
          b.ratedFilmCount - a.ratedFilmCount ||
          a.name.localeCompare(b.name),
    );
  const visibleDirectors = directors.slice(0, directorVisibleCount);

  const periodViewings = films.reduce(
    (total, film) => total + getPeriodWatchCount(film, period),
    0,
  );

  const periodWatchMinutes = periodFilms.reduce(
    (total, film) =>
      total +
      (film.metadata?.runtimeMinutes ?? 0) *
        getPeriodWatchCount(film, period),
    0,
  );

  const periodFilmsWithRuntime = periodFilms.filter(
    (film) => typeof film.metadata?.runtimeMinutes === 'number',
  );

  const periodHours = periodWatchMinutes / 60;

  const allTimeDirectorCount = new Set(
    periodFilms
      .flatMap((film) => film.metadata?.directors ?? [])
      .map((name) => name.trim().toLocaleLowerCase())
      .filter(Boolean),
  ).size;
  const allTimeCountryCount = new Set(
    periodFilms
      .flatMap((film) => film.metadata?.countries ?? [])
      .map((name) => name.trim().toLocaleLowerCase())
      .filter(Boolean),
  ).size;

  const filmsByReleaseYear = new Map<number, number>();
  const ratingsByReleaseYear = new Map<number, { total: number; count: number }>();
  const diaryFilmsByYear = new Map<number, number>();

  for (const film of periodFilms) {
    const tmdbReleaseYear = film.metadata?.releaseDate
      ? Number(film.metadata.releaseDate.slice(0, 4))
      : NaN;
    const releaseYear = Number.isInteger(tmdbReleaseYear)
      ? tmdbReleaseYear
      : film.year;

    if (releaseYear !== null && Number.isInteger(releaseYear)) {
      filmsByReleaseYear.set(releaseYear, (filmsByReleaseYear.get(releaseYear) ?? 0) + 1);
      if (film.rating !== null) {
        const rating = ratingsByReleaseYear.get(releaseYear) ?? { total: 0, count: 0 };
        rating.total += film.rating;
        rating.count += 1;
        ratingsByReleaseYear.set(releaseYear, rating);
      }
    }

    for (const date of film.watchedDates) {
      const loggedYear = Number(date.slice(0, 4));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(loggedYear)) continue;
      diaryFilmsByYear.set(loggedYear, (diaryFilmsByYear.get(loggedYear) ?? 0) + 1);
    }
  }

  const releaseYearKeys = [...filmsByReleaseYear.keys()];
  const diaryYearKeys = [...diaryFilmsByYear.keys()];
  const yearChartYears = (() => {
    const availableYears = yearChartMode === 'diary' ? diaryYearKeys : releaseYearKeys;
    if (availableYears.length === 0) return [];
    const firstYear = Math.min(...availableYears);
    const lastYear = Math.max(...availableYears);
    return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  })();

  const yearChartData = yearChartYears.map((year) => {
    if (yearChartMode === 'diary') {
      const count = diaryFilmsByYear.get(year) ?? 0;
      return {
        year,
        value: count,
        tooltip: `${count} ${count === 1 ? 'film' : 'films'} logged in ${year}`,
      };
    }

    if (yearChartMode === 'ratings') {
      const rating = ratingsByReleaseYear.get(year);
      const average = rating && rating.count > 0 ? rating.total / rating.count : 0;
      return {
        year,
        value: average,
        tooltip: rating && rating.count > 0
          ? `★ ${average.toFixed(2)} average · ${rating.count} rated ${rating.count === 1 ? 'film' : 'films'} released in ${year}`
          : `No rated films released in ${year}`,
      };
    }

    const count = filmsByReleaseYear.get(year) ?? 0;
    return {
      year,
      value: count,
      tooltip: `${count} ${count === 1 ? 'film' : 'films'} released in ${year}`,
    };
  });

  const yearChartMaximum = yearChartMode === 'ratings'
    ? 5
    : Math.max(1, ...yearChartData.map((item) => item.value));

  const ratedFilmsByDecade = new Map<number, { totalRating: number; films: Film[] }>();
  for (const film of periodFilms) {
    if (film.rating === null) continue;
    const tmdbReleaseYear = film.metadata?.releaseDate
      ? Number(film.metadata.releaseDate.slice(0, 4))
      : NaN;
    const releaseYear = Number.isInteger(tmdbReleaseYear)
      ? tmdbReleaseYear
      : film.year;
    if (releaseYear === null || !Number.isInteger(releaseYear)) continue;

    const decade = Math.floor(releaseYear / 10) * 10;
    const group = ratedFilmsByDecade.get(decade) ?? { totalRating: 0, films: [] };
    group.totalRating += film.rating;
    group.films.push(film);
    ratedFilmsByDecade.set(decade, group);
  }

  const highestRatedDecades = [...ratedFilmsByDecade.entries()]
    .map(([decade, group]) => ({
      decade,
      averageRating: group.totalRating / group.films.length,
      films: [...group.films].sort(
        (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.title.localeCompare(b.title),
      ),
      ratedFilmCount: group.films.length,
    }))
    .sort((a, b) =>
      b.averageRating - a.averageRating ||
      b.ratedFilmCount - a.ratedFilmCount ||
      b.decade - a.decade,
    )
    .slice(0, 3)
    .map((decade, index) => ({
      ...decade,
      films: decade.films.slice(0, index === 0 ? 5 : 20),
    }));

  const highestRatedReviewFilms = periodFilms
    .filter((film) => film.rating !== null)
    .filter((film) => {
      if (period === 'all-time') return true;
      if (reviewFilmMode === 'year') return film.year === Number(period);
      return film.year !== null && film.year < Number(period);
    })
    .sort(
      (a, b) =>
        (b.rating ?? -1) - (a.rating ?? -1) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 16);

  const weeklyFilmLogs = (() => {
    if (period === 'all-time') return [];

    const year = Number(period);
    const dayMilliseconds = 24 * 60 * 60 * 1000;
    const weekMilliseconds = 7 * dayMilliseconds;
    const januaryFirst = Date.UTC(year, 0, 1);
    const weekday = new Date(januaryFirst).getUTCDay();
    const firstWeekStart =
      januaryFirst - ((weekday + 6) % 7) * dayMilliseconds;
    const weekCount = Math.ceil(
      (Date.UTC(year + 1, 0, 1) - firstWeekStart) / weekMilliseconds,
    );
    const counts = Array.from({ length: weekCount }, () => 0);

    for (const film of films) {
      for (const date of film.watchedDates) {
        if (!date.startsWith(`${period}-`)) continue;

        const timestamp = Date.parse(`${date}T00:00:00Z`);
        if (!Number.isFinite(timestamp)) continue;

        const weekIndex = Math.floor(
          (timestamp - firstWeekStart) / weekMilliseconds,
        );
        if (weekIndex >= 0 && weekIndex < counts.length) {
          counts[weekIndex] += 1;
        }
      }
    }

    return counts.map((count, index) => {
      const weekStart = new Date(
        firstWeekStart + index * weekMilliseconds,
      ).toISOString().slice(0, 10);
      const weekEnd = new Date(
        firstWeekStart + (index + 1) * weekMilliseconds - dayMilliseconds,
      ).toISOString().slice(0, 10);

      return { count, weekStart, weekEnd };
    });
  })();

  const maxWeeklyFilmLogs = Math.max(
    1,
    ...weeklyFilmLogs.map((week) => week.count),
  );

  const watchedDatesThisYear =
    period === 'all-time'
      ? []
      : films.flatMap((film) => film.watchedDates).filter((date) =>
          date.startsWith(`${period}-`),
        );
  const totalFilmsWatched = watchedDatesThisYear.length;
  const weekdayNames = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const weekdayFilmLogs = Array.from({ length: 7 }, () => 0);

  for (const date of watchedDatesThisYear) {
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp)) continue;

    const weekday = new Date(timestamp).getUTCDay();
    weekdayFilmLogs[(weekday + 6) % 7] += 1;
  }

  const selectedYearNumber = Number(period);
  const currentDate = new Date();
  const currentYearNumber = currentDate.getFullYear();
  const monthsElapsed =
    period === 'all-time'
      ? 0
      : selectedYearNumber === currentYearNumber
        ? currentDate.getMonth() + 1
        : 12;
  const daysElapsed =
    period === 'all-time'
      ? 0
      : selectedYearNumber === currentYearNumber
        ? Math.floor(
            (Date.UTC(
              selectedYearNumber,
              currentDate.getMonth(),
              currentDate.getDate(),
            ) -
              Date.UTC(selectedYearNumber, 0, 1)) /
              (24 * 60 * 60 * 1000),
          ) + 1
        : 365 +
          (selectedYearNumber % 4 === 0 &&
          (selectedYearNumber % 100 !== 0 || selectedYearNumber % 400 === 0)
            ? 1
            : 0);
  const weeksElapsed =
    period === 'all-time'
      ? 0
      : selectedYearNumber === currentYearNumber
        ? Math.max(1, Math.ceil(daysElapsed / 7))
        : 52;
  const averageFilmsPerMonth =
    monthsElapsed > 0 ? totalFilmsWatched / monthsElapsed : 0;
  const averageFilmsPerWeek =
    weeksElapsed > 0 ? totalFilmsWatched / weeksElapsed : 0;
  const maxWeekdayFilmLogs = Math.max(1, ...weekdayFilmLogs);

  const reviewLogEntries = films
    .flatMap((film) =>
      (film.watchedDates)
        .filter((date) => period === 'all-time' || date.startsWith(`${period}-`))
        .map((date) => ({ film, date })),
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.film.title.localeCompare(b.film.title),
    );

  const milestoneSlotCount = Math.max(
    8,
    Math.floor(reviewLogEntries.length / 50) + 1,
  );
  const diaryMilestones = Array.from(
    { length: milestoneSlotCount },
    (_, index) => {
      const position = (index + 1) * 50;
      return {
        position,
        entry: reviewLogEntries[position - 1] ?? null,
      };
    },
  );

  const mostWatchedFilms = films
    .map((film) => ({
      film,
      watchCount: getPeriodWatchCount(film, period),
    }))
    .filter((item) => item.watchCount > 1)
    .sort(
      (a, b) =>
        b.watchCount - a.watchCount ||
        a.film.title.localeCompare(b.film.title),
    );
  const mostWatchedSlots = Array.from(
    { length: 8 },
    (_, index) => mostWatchedFilms[index] ?? null,
  );

  const getTasteRows = (category: 'genres' | 'countries' | 'languages') => {
    const totals = new Map<
      string,
      { watchCount: number; ratingTotal: number; ratedFilmCount: number }
    >();

    for (const film of periodFilms) {
      const categoryNames =
        category === 'genres'
          ? film.metadata?.genres ?? []
          : category === 'countries'
            ? film.metadata?.countries ?? []
            : [getLanguageLabel(film.metadata?.originalLanguage)];
      const uniqueNames = new Set(
        categoryNames.map((name) => name.trim()).filter(Boolean),
      );
      const watchCount = getPeriodWatchCount(film, period);

      for (const name of uniqueNames) {
        const current = totals.get(name) ?? {
          watchCount: 0,
          ratingTotal: 0,
          ratedFilmCount: 0,
        };
        current.watchCount += watchCount;

        if (film.rating !== null) {
          current.ratingTotal += film.rating;
          current.ratedFilmCount += 1;
        }

        totals.set(name, current);
      }
    }

    return [...totals.entries()]
      .map(([name, stats]) => ({
        name,
        ...stats,
        averageRating:
          stats.ratedFilmCount > 0
            ? stats.ratingTotal / stats.ratedFilmCount
            : null,
      }))
      .filter((item) =>
        tasteMode === 'most-watched'
          ? item.watchCount > 0
          : item.averageRating !== null,
      )
      .sort((a, b) => {
        if (tasteMode === 'most-watched') {
          return b.watchCount - a.watchCount || a.name.localeCompare(b.name);
        }

        return (
          (b.averageRating ?? -1) - (a.averageRating ?? -1) ||
          b.ratedFilmCount - a.ratedFilmCount ||
          a.name.localeCompare(b.name)
        );
      })
      .slice(0, 10);
  };

  const tasteGroups = [
    { key: 'genres', label: 'Genres', items: getTasteRows('genres') },
    { key: 'countries', label: 'Countries', items: getTasteRows('countries') },
    { key: 'languages', label: 'Languages', items: getTasteRows('languages') },
  ];

  const ratingBuckets = Array.from({ length: 10 }, (_, index) => (index + 1) / 2);
  const reviewRatingDistribution = ratingBuckets.map((rating) => ({
    rating,
    count: periodFilms.filter((film) => film.rating === rating).length,
  }));
  const reviewMaxRatingCount = Math.max(
    1,
    ...reviewRatingDistribution.map((bucket) => bucket.count),
  );

  const isPremiereFilm = (film: Film): boolean => {
    if (period !== 'all-time') return film.year === Number(period);
    const releaseYear = film.year;
    return (
      releaseYear !== null &&
      film.watchedDates.some((date) => date.startsWith(`${releaseYear}-`))
    );
  };
  const premiereFilmCount = periodFilms.filter(isPremiereFilm).length;
  const olderFilmCount = periodFilms.length - premiereFilmCount;

  const rewatchFilmCount = periodFilms.filter((film) => {
    if (period === 'all-time') return film.watchedDates.length > 1;
    return film.watchedDates.some(
      (date) => Number(date.slice(0, 4)) < Number(period),
    );
  }).length;
  const newWatchFilmCount = periodFilms.length - rewatchFilmCount;
  const ratedFilmCount = reviewRatingDistribution.reduce(
    (total, bucket) => total + bucket.count,
    0,
  );
  const userVsTmdbFilms = periodFilms
    .filter(
      (film) =>
        film.rating !== null &&
        typeof film.metadata?.tmdbRating === 'number' &&
        typeof film.metadata.tmdbVoteCount === 'number' &&
        film.metadata.tmdbVoteCount > 0,
    )
    .map((film) => {
      const tmdbAverage = (film.metadata?.tmdbRating ?? 0) / 2;
      const userRating = film.rating ?? 0;

      return {
        film,
        tmdbAverage,
        difference: userRating - tmdbAverage,
      };
    });
  const ratedHigherThanAverage = [...userVsTmdbFilms]
    .filter((item) => item.difference > 0)
    .sort(
      (a, b) =>
        b.difference - a.difference ||
        (b.film.rating ?? 0) - (a.film.rating ?? 0) ||
        a.film.title.localeCompare(b.film.title),
    )
    .slice(0, period === 'all-time' ? 10 : 5);
  const ratedLowerThanAverage = [...userVsTmdbFilms]
    .filter((item) => item.difference < 0)
    .sort(
      (a, b) =>
        a.difference - b.difference ||
        (a.film.rating ?? 0) - (b.film.rating ?? 0) ||
        a.film.title.localeCompare(b.film.title),
    )
    .slice(0, period === 'all-time' ? 10 : 5);

  const renderTasteSection = () => (
              <section className="review-taste-section" aria-label="Genres, countries and languages">
                <div className="review-taste-heading">
                  <h2>Genres, Countries &amp; Languages</h2>
                  <span className="review-taste-rule" aria-hidden="true" />
                  <div className="review-taste-tabs" role="tablist" aria-label="Category ranking mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tasteMode === 'most-watched'}
                      className={tasteMode === 'most-watched' ? 'active' : ''}
                      onClick={() => setTasteMode('most-watched')}
                    >
                      Most Watched
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tasteMode === 'highest-rated'}
                      className={tasteMode === 'highest-rated' ? 'active' : ''}
                      onClick={() => setTasteMode('highest-rated')}
                    >
                      Highest Rated
                    </button>
                  </div>
                </div>

                <div className="review-taste-grid">
                  {tasteGroups.map((group) => {
                    const maximum = Math.max(
                      1,
                      ...group.items.map((item) =>
                        tasteMode === 'most-watched'
                          ? item.watchCount
                          : item.averageRating ?? 0,
                      ),
                    );

                    return (
                      <section
                        className={`review-taste-group review-taste-${group.key}`}
                        key={group.key}
                        aria-label={group.label}
                      >
                        <h3>{group.label}</h3>
                        {group.items.length > 0 ? (
                          <div className="review-taste-rows">
                            {group.items.map((item) => {
                              const value =
                                tasteMode === 'most-watched'
                                  ? item.watchCount
                                  : item.averageRating ?? 0;
                              const width =
                                tasteMode === 'most-watched'
                                  ? (value / maximum) * 100
                                  : (value / 5) * 100;
                              const detail =
                                tasteMode === 'most-watched'
                                  ? `${item.watchCount} viewings`
                                  : `Average rating ${item.averageRating?.toFixed(2)} / 5 from ${item.ratedFilmCount} rated films`;

                              return (
                                <div className="review-taste-row" key={item.name} title={`${item.name} · ${detail}`}>
                                  <span>{item.name}</span>
                                  <div className="review-taste-track" aria-hidden="true">
                                    <div
                                      className="review-taste-bar"
                                      style={{ width: `${width}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="review-taste-empty">
                            {tasteMode === 'highest-rated'
                              ? 'No ratings available.'
                              : group.key === 'languages'
                                ? 'Language details will appear after TMDB data is refreshed.'
                                : 'No data available for this period.'}
                          </p>
                        )}
                      </section>
                    );
                  })}
                </div>
              </section>
  );

  const renderRatingsComparisonSection = () => (
              <section className="review-ratings-comparison-section" aria-label="Ratings compared with the TMDB average">
                <div className="review-ratings-comparison-block">
                  <div className="review-ratings-comparison-heading">
                    <h2>Rated Higher Than Average</h2>
                    <span aria-hidden="true" />
                  </div>
                  {ratedHigherThanAverage.length > 0 ? (
                    <div className="review-ratings-comparison-grid">
                      {ratedHigherThanAverage.map(({ film, tmdbAverage }) => (
                        <article className="review-ratings-comparison-card" key={film.key} title={film.title}>
                          <div className="review-ratings-comparison-poster">
                            {film.metadata?.posterPath ? (
                              <img
                                src={`https://image.tmdb.org/t/p/w342${film.metadata.posterPath}`}
                                alt={film.title}
                                loading="lazy"
                              />
                            ) : (
                              <span>{film.title}</span>
                            )}
                          </div>
                          <p>★ {film.rating?.toFixed(1)} <span>vs {tmdbAverage.toFixed(2)}</span></p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="review-ratings-comparison-empty">No films were rated above their TMDB average in this period.</p>
                  )}
                </div>

                <div className="review-ratings-comparison-block">
                  <div className="review-ratings-comparison-heading">
                    <h2>Rated Lower Than Average</h2>
                    <span aria-hidden="true" />
                  </div>
                  {ratedLowerThanAverage.length > 0 ? (
                    <div className="review-ratings-comparison-grid">
                      {ratedLowerThanAverage.map(({ film, tmdbAverage }) => (
                        <article className="review-ratings-comparison-card" key={film.key} title={film.title}>
                          <div className="review-ratings-comparison-poster">
                            {film.metadata?.posterPath ? (
                              <img
                                src={`https://image.tmdb.org/t/p/w342${film.metadata.posterPath}`}
                                alt={film.title}
                                loading="lazy"
                              />
                            ) : (
                              <span>{film.title}</span>
                            )}
                          </div>
                          <p>★ {film.rating?.toFixed(1)} <span>vs {tmdbAverage.toFixed(2)}</span></p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="review-ratings-comparison-empty">No films were rated below their TMDB average in this period.</p>
                  )}
                </div>
              </section>
  );

  return (    <main className="app-shell">
      <header className="app-header">
        <p className="app-breadcrumb">
          LETTERBOXED STATS <span>/</span>{' '}
          {activeTab === 'films'
            ? 'YOUR FILM ARCHIVE'
            : activeTab === 'review'
              ? 'YOUR YEAR IN REVIEW'
              : 'YOUR OVERVIEW'}
        </p>

        <div className="header-actions">
          <span className="header-library-count">
            {filmCollection.length} FILMS
          </span>

          <label
            className={`header-import ${
              busy || enrichBusy || manualBusyKey !== null ? 'disabled' : ''
            }`}
            htmlFor="account-export-file"
          >
            ☁ Import data
          </label>
          <input
            className="visually-hidden"
            id="account-export-file"
            type="file"
            accept=".zip,application/zip"
            onChange={handleImport}
            disabled={busy || enrichBusy || manualBusyKey !== null}
          />
        </div>
      </header>

      <div className="app-layout">
        <nav className="app-tabs" aria-label="Main sections">
          <div className="sidebar-brand">
            <span className="sidebar-brand-icon letterboxd-dots" aria-hidden="true">
              <span className="letterboxd-dot letterboxd-dot-orange" />
              <span className="letterboxd-dot letterboxd-dot-green" />
              <span className="letterboxd-dot letterboxd-dot-blue" />
            </span>
            <span>
              <strong>Letterboxed Stats</strong>
              <small>Your film history</small>
            </span>
          </div>

          <p className="sidebar-section-label">YOUR WORLD</p>

          <button
            type="button"
            className={activeTab === 'dashboard' ? 'app-tab active' : 'app-tab'}
            aria-pressed={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
          >
            <span aria-hidden="true">▦</span>
            Overview
          </button>

          <button
            type="button"
            className={activeTab === 'films' ? 'app-tab active' : 'app-tab'}
            aria-pressed={activeTab === 'films'}
            onClick={() => setActiveTab('films')}
          >
            <span aria-hidden="true">▣</span>
            Film library
          </button>

          <button
            type="button"
            className={activeTab === 'review' ? 'app-tab active' : 'app-tab'}
            aria-pressed={activeTab === 'review'}
            onClick={() => setActiveTab('review')}
          >
            <span aria-hidden="true">✦</span>
            Year in Review
          </button>

          <div className="sidebar-footer">
            <strong>MADE FOR FILM LOVERS ♡</strong>
            <span>Not affiliated with Letterboxd or TMDB.</span>
          </div>
        </nav>

        <div className="app-page-content">
          {activeTab === 'dashboard' && (
            <div className="dashboard-panel">
              <section className="dashboard-upload">
                <div className="section-heading">
                  <div>
                    <p className="wrapped-eyebrow">YOUR LIBRARY</p>
                    <h1>Your films, in perspective.</h1>
                    <p>Add your Letterboxd data to explore your film history.</p>
                  </div>
                </div>

                <p role="status">{status}</p>
                {error && <p role="alert">{error}</p>}

                <h2>Movie details</h2>
                <p>TMDB details are enriched automatically after import.</p>

                {enrichBusy && enrichStats.total > 0 && (
                  <div className="enrichment-progress" role="status">
                    <div className="enrichment-progress-heading">
                      <strong>Enriching movie details</strong>
                      <span>
                        {Math.round(
                          (enrichStats.completed / enrichStats.total) * 100,
                        )}
                        %
                      </span>
                    </div>

                    <progress
                      className="enrichment-progress-bar"
                      value={enrichStats.completed}
                      max={enrichStats.total}
                      aria-label="TMDB enrichment progress"
                    />

                    <div className="enrichment-progress-info">
                      <span>
                        {enrichStats.completed} of {enrichStats.total} films
                        checked ·{' '}
                        {enrichStats.total - enrichStats.completed} remaining
                      </span>
                      <span>
                        Elapsed {formatDuration(enrichElapsedSeconds)}
                      </span>
                    </div>

                    <p className="enrichment-current-film">
                      {enrichProgress}
                    </p>

                    <p className="enrichment-eta">
                      {enrichStats.etaSeconds === null
                        ? 'Estimating time remaining…'
                        : `About ${formatDuration(enrichStats.etaSeconds)} remaining`}
                    </p>
                  </div>
                )}

                {enrichMessage && <p role="status">{enrichMessage}</p>}
                {enrichError && <p role="alert">{enrichError}</p>}

                {!busy && !enrichBusy && unmatchedFilms.length > 0 && (
                  <details className="dashboard-matches">
                    <summary>
                      <span>Review unmatched films</span>
                      <span className="unmatched-count">
                        {unmatchedFilms.length} left
                      </span>
                    </summary>

                    <p>
                      {unmatchedFilms.length} watched or rated films need a TMDB
                      match. Choose a result only when the title and year are
                      correct.
                    </p>

                    {manualMessage && <p role="status">{manualMessage}</p>}
                    {manualError && <p role="alert">{manualError}</p>}

                    <ol>
                      {unmatchedFilms.map((film) => {
                        const searchResults = manualSearchResults[film.key];

                        return (
                          <li key={film.key}>
                            <strong>
                              {film.title} ({film.year ?? 'year unknown'})
                            </strong>{' '}
                            <button
                              type="button"
                              onClick={() => void searchManualMatches(film)}
                              disabled={manualBusyKey !== null || enrichBusy}
                            >
                              {manualBusyKey === film.key
                                ? 'Searching…'
                                : 'Search TMDB'}
                            </button>

                            {searchResults && searchResults.length === 0 && (
                              <p>
                                No TMDB results found for this title and year.
                              </p>
                            )}

                            {searchResults && searchResults.length > 0 && (
                              <ul className="tmdb-match-list">
                                {searchResults.map((match) => (
                                  <li
                                    key={match.id}
                                    className="tmdb-match-card"
                                  >
                                    {match.poster_path ? (
                                      <img
                                        className="tmdb-match-poster"
                                        src={`https://image.tmdb.org/t/p/w185${match.poster_path}`}
                                        alt={`Poster for ${match.title}`}
                                        loading="lazy"
                                      />
                                    ) : (
                                      <div className="tmdb-match-poster tmdb-poster-placeholder">
                                        No poster
                                      </div>
                                    )}

                                    <div className="tmdb-match-info">
                                      <h4>
                                        {match.title} (
                                        {match.release_date
                                          ? match.release_date.slice(0, 4)
                                          : 'year unknown'}
                                        )
                                      </h4>
                                      {match.original_title !==
                                        match.title && (
                                        <p>
                                          Original title:{' '}
                                          {match.original_title}
                                        </p>
                                      )}
                                      <p className="tmdb-match-meta">
                                        {match.original_language?.toUpperCase() ??
                                          'Language unknown'}
                                        {match.vote_average
                                          ? ` · TMDB score ${match.vote_average.toFixed(1)} / 10`
                                          : ''}
                                      </p>
                                      <p className="tmdb-match-overview">
                                        {match.overview ||
                                          'No synopsis available.'}
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void saveManualMatch(film, match)
                                        }
                                        disabled={
                                          manualBusyKey !== null || enrichBusy
                                        }
                                      >
                                        {manualBusyKey === film.key
                                          ? 'Saving…'
                                          : 'Use this match'}
                                      </button>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </details>
                )}
              </section>

              
            </div>
          )}

          {activeTab === 'films' && (
            <section className="films-page">
              <div className="films-heading">
                <div>
                  <p className="wrapped-eyebrow">02 / THE ARCHIVE</p>
                  <h1>Every frame you collected</h1>
                  <p>
                    Search, sort, and rediscover the films that make up your
                    story.
                  </p>
                </div>
                <span className="films-count">
                  {filmCollection.length} FILMS
                </span>
              </div>

              <div className="films-filters">
                <input
                  type="search"
                  value={filmSearch}
                  onChange={(event) => setFilmSearch(event.target.value)}
                  placeholder="⌕  Find a film..."
                  aria-label="Search films"
                />

                <select
                  value={genreFilter}
                  onChange={(event) => setGenreFilter(event.target.value)}
                  aria-label="Filter by genre"
                >
                  <option value="all">All genres</option>
                  {filmGenres.map((genre) => (
                    <option key={genre} value={genre}>
                      {genre}
                    </option>
                  ))}
                </select>

                <select
                  value={directorFilter}
                  onChange={(event) => setDirectorFilter(event.target.value)}
                  aria-label="Filter by director"
                >
                  <option value="all">All directors</option>
                  {filmDirectors.map((director) => (
                    <option key={director} value={director}>
                      {director}
                    </option>
                  ))}
                </select>

                <select
                  value={countryFilter}
                  onChange={(event) => setCountryFilter(event.target.value)}
                  aria-label="Filter by country"
                >
                  <option value="all">All countries</option>
                  {filmCountries.map((country) => (
                    <option key={country} value={country}>
                      {country}
                    </option>
                  ))}
                </select>

                <select
                  value={scoreFilter}
                  onChange={(event) => setScoreFilter(event.target.value)}
                  aria-label="Filter by Letterboxd rating"
                >
                  <option value="all">All ratings</option>
                  <option value="unrated">Unrated</option>
                  {filmScores.map((score) => (
                    <option key={score} value={score}>
                      {score.toFixed(1)} / 5
                    </option>
                  ))}
                </select>

                <select
                  value={filmSort}
                  onChange={(event) =>
                    setFilmSort(event.target.value as FilmSort)
                  }
                  aria-label="Sort films"
                >
                  <option value="title">Title: A–Z</option>
                  <option value="rating-high">Highest rated</option>
                  <option value="rating-low">Lowest rated</option>
                  <option value="year-new">Newest first</option>
                  <option value="year-old">Oldest first</option>
                </select>
              </div>

              {visibleFilms.length > 0 ? (
                <div className="films-list">
                  {visibleFilms.map((film) => (
                    <article className="film-card" key={film.key}>
                      <div className="film-card-poster">
                        {film.metadata?.posterPath ? (
                          <img
                            src={`https://image.tmdb.org/t/p/w500${film.metadata.posterPath}`}
                            alt={`Poster for ${film.title}`}
                            loading="lazy"
                          />
                        ) : (
                          <div className="film-poster-empty">
                            {film.metadata?.tmdbId
                              ? 'No poster available'
                              : 'TMDB match needed'}
                          </div>
                        )}
                      </div>

                      <div className="film-card-info">
                        <h3 title={film.title}>{film.title}</h3>
                        <div className="film-card-details">
                          <span>{film.year ?? 'Year unknown'}</span>
                          {film.rating !== null && (
                            <strong>★ {film.rating.toFixed(1)}</strong>
                          )}
                        </div>
                        {!film.metadata?.tmdbId && (
                          <span className="film-card-unmatched">
                            TMDB data needs review
                          </span>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="films-empty">
                  No films match those search and filter options.
                </p>
              )}
            </section>
          )}

          {activeTab === 'review' && (
            <div className="review-panel">
              <section className={`review-hero ${period === 'all-time' ? 'review-hero-all-time' : ''}`}>
                <div
                  className="review-spectrum review-spectrum-left"
                  aria-hidden="true"
                >
                  {spectrumHeights.map((height, index) => (
                    <span key={`left-${index}`} style={{ height: `${height}px` }} />
                  ))}
                </div>

                <div
                  className="review-spectrum review-spectrum-right"
                  aria-hidden="true"
                >
                  {spectrumHeights.map((height, index) => (
                    <span
                      key={`right-${index}`}
                      style={{ height: `${height}px` }}
                    />
                  ))}
                </div>

                <div className="review-hero-content">
                  <p className="review-eyebrow">YOUR YEAR IN FILM</p>

                  <div className="review-year-picker">
                    <h1
                      className={`review-year-display ${period === 'all-time' ? 'review-year-display-all-time' : ''}`}
                      aria-live="polite"
                    >
                      {period === 'all-time' ? 'A Life in Film' : period}
                    </h1>
                    <label className="review-year-control">
                      <span className="visually-hidden">
                        Choose a Year in Review period
                      </span>
                      <select
                        className="review-year-select"
                        value={period}
                        onChange={(event) => {
                          setPeriod(event.target.value);
                          setCastVisibleCount(10);
                          setDirectorVisibleCount(10);
                          setReviewFilmMode('year');
                        }}
                        aria-label="Choose a Year in Review period"
                      >
                        <option value="all-time">All time</option>
                        {years.map((year) => (
                          <option key={year} value={year}>
                            {year}
                          </option>
                        ))}
                      </select>
                      <span aria-hidden="true">⌄</span>
                    </label>
                  </div>

                  <p className="review-subtitle">
                    {period === 'all-time'
                      ? 'Your complete film history'
                      : `Your ${period} in film`}
                  </p>
                </div>
              </section>

              <section
                className={`review-stats ${period === 'all-time' ? 'review-stats-all-time' : ''}`}
                aria-label="Viewing statistics"
              >
                {period === 'all-time' ? (
                  <>
                    <article className="review-stat">
                      <strong>{periodViewings.toLocaleString()}</strong>
                      <span>Films</span>
                    </article>

                    <article className="review-stat">
                      <strong>
                        {periodFilmsWithRuntime.length > 0
                          ? Math.round(periodHours).toLocaleString()
                          : '—'}
                      </strong>
                      <span>Hours</span>
                    </article>

                    <article className="review-stat">
                      <strong>{allTimeDirectorCount.toLocaleString()}</strong>
                      <span>Directors</span>
                    </article>

                    <article className="review-stat">
                      <strong>{allTimeCountryCount.toLocaleString()}</strong>
                      <span>Countries</span>
                    </article>
                  </>
                ) : (
                  <>
                    <article className="review-stat">
                      <strong>{periodViewings}</strong>
                      <span>Film viewings</span>
                    </article>

                    <article className="review-stat">
                      <strong>{periodFilms.length}</strong>
                      <span>Films watched</span>
                    </article>

                    <article className="review-stat">
                      <strong>
                        {periodFilmsWithRuntime.length > 0
                          ? periodHours.toFixed(1)
                          : '—'}
                      </strong>
                      <span>Estimated hours</span>
                    </article>
                  </>
                )}
              </section>

              <p className="review-runtime-note">
                {periodFilmsWithRuntime.length > 0
                  ? `Hours are estimated from TMDB runtimes for ${periodFilmsWithRuntime.length} of ${periodFilms.length} films in this period.`
                  : 'Runtime data is not available for films in this period yet.'}
              </p>

              {period === 'all-time' && (
                <section className="review-by-year-section" aria-label="Library activity by year">
                  <div className="review-by-year-heading">
                    <h2>By year</h2>
                    <span className="review-by-year-rule" aria-hidden="true" />
                    <div className="review-by-year-tabs" role="tablist" aria-label="By year chart type">
                      {([
                        ['films', 'Films'],
                        ['ratings', 'Ratings'],
                        ['diary', 'Diary'],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          role="tab"
                          aria-selected={yearChartMode === mode}
                          className={yearChartMode === mode ? 'active' : ''}
                          onClick={() => setYearChartMode(mode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {yearChartData.some((item) => item.value > 0) ? (
                    <>
                      <div
                        className={`review-by-year-chart review-by-year-chart-${yearChartMode}`}
                        style={{ gridTemplateColumns: `repeat(${yearChartData.length}, minmax(0, 1fr))` }}
                        aria-label={`${yearChartMode === 'films' ? 'Films released' : yearChartMode === 'ratings' ? 'Average ratings by release year' : 'Diary entries by logged year'}`}
                      >
                        {yearChartData.map((item, index) => {
                          const ratio = index / Math.max(1, yearChartData.length - 1);
                          const color = yearChartMode === 'ratings'
                            ? `hsl(${42 + ratio * 10}, 96%, 65%)`
                            : yearChartMode === 'diary'
                              ? `hsl(${145 + ratio * 20}, 90%, 57%)`
                              : `hsl(${145 + ratio * 48}, 88%, 46%)`;
                          const height = item.value > 0
                            ? Math.max(3, (item.value / yearChartMaximum) * 100)
                            : 0;

                          return (
                            <div
                              className="review-by-year-column"
                              key={item.year}
                              role="img"
                              aria-label={item.tooltip}
                              title={item.tooltip}
                            >
                              <span
                                className="review-by-year-bar"
                                style={{ height: `${height}%`, backgroundColor: color }}
                              />
                            </div>
                          );
                        })}
                      </div>
                      <div className="review-by-year-axis" aria-hidden="true">
                        <span>{yearChartYears[0]}</span>
                        <span>{yearChartYears[yearChartYears.length - 1]}</span>
                      </div>
                    </>
                  ) : (
                    <p className="review-by-year-empty">
                      {yearChartMode === 'diary'
                        ? 'No diary dates are available. Re-import your Letterboxd ZIP to add diary years.'
                        : yearChartMode === 'ratings'
                          ? 'No rated films with a release year are available.'
                          : 'No films with a release year are available.'}
                    </p>
                  )}
                </section>
              )}

              {period === 'all-time' && (
                <section className="review-decades-section" aria-label="Highest rated decades">
                  <div className="review-decades-heading">
                    <h2>Highest rated decades</h2>
                    <span aria-hidden="true" />
                  </div>

                  {highestRatedDecades.length > 0 ? (
                    <div className="review-decades-list">
                      {highestRatedDecades.map((decade, index) => (
                        <article
                          className={`review-decade-row ${index === 0 ? 'is-highest' : ''}`}
                          key={decade.decade}
                        >
                          <div className="review-decade-summary">
                            <h3>{decade.decade}s</h3>
                            <p>★ Average {decade.averageRating.toFixed(2)}</p>
                          </div>

                          <div className={`review-decade-posters ${index === 0 ? 'is-featured' : ''}`}>
                            {decade.films.map((film) => (
                              <article
                                className="review-decade-film"
                                key={film.key}
                                title={`${film.title} (${film.year ?? 'year unknown'}) · ★ ${film.rating?.toFixed(1)}`}
                              >
                                <div className="review-decade-poster">
                                  {film.metadata?.posterPath ? (
                                    <img
                                      src={`https://image.tmdb.org/t/p/w342${film.metadata.posterPath}`}
                                      alt={`Poster for ${film.title}`}
                                      loading="lazy"
                                    />
                                  ) : (
                                    <span>{film.title}</span>
                                  )}
                                </div>
                              </article>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="review-decades-empty">No rated watched films with a release decade are available.</p>
                  )}
                </section>
              )}

              {period !== 'all-time' && (
              <section className="review-films" aria-label="Highest rated films">
                <div className="review-films-heading">
                  <h2>Highest rated films</h2>
                  <span className="review-films-rule" aria-hidden="true" />
                  <div className="review-films-tabs" role="tablist" aria-label="Filter highest rated films">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={reviewFilmMode === 'year'}
                      className={reviewFilmMode === 'year' ? 'active' : ''}
                      onClick={() => setReviewFilmMode('year')}
                    >
                      {period === 'all-time' ? 'All time' : period}
                    </button>
                    {period !== 'all-time' && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={reviewFilmMode === 'older'}
                        className={reviewFilmMode === 'older' ? 'active' : ''}
                        onClick={() => setReviewFilmMode('older')}
                      >
                        Older
                      </button>
                    )}
                  </div>
                </div>

                {highestRatedReviewFilms.length > 0 ? (
                  <div className="review-films-grid">
                    {highestRatedReviewFilms.map((film) => (
                      <article className="review-film-card" key={film.key}>
                        <div className="review-film-poster">
                          {film.metadata?.posterPath ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w500${film.metadata.posterPath}`}
                              alt={`Poster for ${film.title}`}
                              loading="lazy"
                            />
                          ) : (
                            <div className="review-film-poster-empty">
                              {film.title}
                            </div>
                          )}
                        </div>
                        <h3 title={film.title}>{film.title}</h3>
                        <div className="review-film-meta">
                          <span>{film.year ?? 'Year unknown'}</span>
                          <strong aria-label={`${film.rating?.toFixed(1)} out of 5 stars`}>
                            ★ {film.rating?.toFixed(1)}
                          </strong>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="review-films-empty">
                    {period === 'all-time'
                      ? 'No rated watched films found.'
                      : reviewFilmMode === 'year'
                        ? `No rated films released in ${period} were watched during that year.`
                        : `No rated films released before ${period} were watched during that year.`}
                  </p>
                )}
              </section>
              )}

              {period !== 'all-time' && (
                <section className="review-week-section" aria-label="Films watched by week">
                  <div className="review-week-heading">
                    <h2>By week</h2>
                    <span className="review-week-rule" aria-hidden="true" />
                    <span className="review-week-mode">Films</span>
                  </div>

                  {weeklyFilmLogs.length > 0 && weeklyFilmLogs.some((week) => week.count > 0) ? (
                    <>
                      <div
                        className="review-week-chart"
                        style={{ gridTemplateColumns: `repeat(${weeklyFilmLogs.length}, minmax(0, 1fr))` }}
                        aria-label={`${period} films watched each week`}
                      >
                        {weeklyFilmLogs.map((week, index) => {
                          const hue = 145 + (index / Math.max(1, weeklyFilmLogs.length - 1)) * 48;
                          const height = week.count
                            ? Math.max(5, (week.count / maxWeeklyFilmLogs) * 100)
                            : 0;

                          return (
                            <div
                              className="review-week-column"
                              key={week.weekStart}
                              role="img"
                              aria-label={`${week.count} film${week.count === 1 ? '' : 's'} logged, ${week.weekStart} to ${week.weekEnd}`}
                              title={`${week.count} film${week.count === 1 ? '' : 's'} logged · ${week.weekStart} to ${week.weekEnd}`}
                            >
                              <span
                                className="review-week-bar"
                                style={{ height: `${height}%`, backgroundColor: `hsl(${hue}, 88%, 46%)` }}
                              />
                            </div>
                          );
                        })}
                      </div>
                      <div className="review-week-axis" aria-hidden="true">
                        <span>Jan</span>
                        <span>Dec</span>
                      </div>
                    </>
                  ) : (
                    <p className="review-week-message">
                      Viewing dates are not saved in this library yet. Re-import your Letterboxd ZIP to see weekly activity.
                    </p>
                  )}
                </section>
              )}

              {period !== 'all-time' && totalFilmsWatched > 0 && (
                <section className="review-log-summary" aria-label="Viewing summary">
                  <div className="review-log-metrics">
                    <article className="review-log-stat">
                      <strong>{totalFilmsWatched}</strong>
                      <span>Films watched</span>
                    </article>
                    <span className="review-log-arrow" aria-hidden="true">→</span>
                    <article className="review-log-stat">
                      <strong>{averageFilmsPerMonth.toFixed(1)}</strong>
                      <span>Average per month</span>
                    </article>
                    <span className="review-log-arrow" aria-hidden="true">→</span>
                    <article className="review-log-stat">
                      <strong>{averageFilmsPerWeek.toFixed(1)}</strong>
                      <span>Average per week</span>
                    </article>
                  </div>

                  <div className="review-weekday-chart" aria-label="Films watched by day of the week">
                    {weekdayFilmLogs.map((count, index) => {
                      const height = count
                        ? Math.max(6, (count / maxWeekdayFilmLogs) * 100)
                        : 0;

                      return (
                        <div
                          className="review-weekday-column"
                          key={`${weekdayNames[index]}-${index}`}
                          role="img"
                          aria-label={`${count} films watched on ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index]}`}
                          title={`${count} films watched on ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index]}`}
                        >
                          <span
                            className="review-weekday-bar"
                            style={{ height: `${height}%` }}
                          />
                          <small>{weekdayNames[index]}</small>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {period === 'all-time' && renderTasteSection()}

              {period !== 'all-time' && (
              <section className="review-milestones-section" aria-label="Film milestones">
                <div className="review-milestones-heading">
                  <h2>Milestones</h2>
                  <span aria-hidden="true" />
                </div>

                <div className="review-milestones-layout">
                  <article className="review-milestone-feature">
                    <h3>First Film</h3>
                    {reviewLogEntries[0] ? (
                      <>
                        <div className="review-milestone-poster" title={reviewLogEntries[0].film.title}>
                          {reviewLogEntries[0].film.metadata?.posterPath ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w500${reviewLogEntries[0].film.metadata.posterPath}`}
                              alt={reviewLogEntries[0].film.title}
                              loading="lazy"
                            />
                          ) : (
                            <span>{reviewLogEntries[0].film.title}</span>
                          )}
                        </div>
                        <p>{new Date(`${reviewLogEntries[0].date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</p>
                      </>
                    ) : (
                      <div className="review-milestone-poster is-empty" aria-hidden="true" />
                    )}
                  </article>

                  <div className="review-milestones-center">
                    <h3>Diary Milestones</h3>
                    <div className="review-milestones-grid">
                      {diaryMilestones.map(({ position, entry }) => (
                        entry ? (
                          <article className="review-milestone-card" key={position}>
                            <div className="review-milestone-poster" title={entry.film.title}>
                              {entry.film.metadata?.posterPath ? (
                                <img
                                  src={`https://image.tmdb.org/t/p/w500${entry.film.metadata.posterPath}`}
                                  alt={`${position}th logged film: ${entry.film.title}`}
                                  loading="lazy"
                                />
                              ) : (
                                <span>{entry.film.title}</span>
                              )}
                            </div>
                            <strong>{position}TH</strong>
                            <p>{new Date(`${entry.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</p>
                          </article>
                        ) : (
                          <div
                            className="review-milestone-poster is-empty"
                            key={position}
                            aria-label={`${position}th milestone not reached`}
                          />
                        )
                      ))}
                    </div>
                  </div>

                  <article className="review-milestone-feature">
                    <h3>Last Film</h3>
                    {reviewLogEntries.length > 0 ? (
                      <>
                        <div className="review-milestone-poster" title={reviewLogEntries[reviewLogEntries.length - 1].film.title}>
                          {reviewLogEntries[reviewLogEntries.length - 1].film.metadata?.posterPath ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w500${reviewLogEntries[reviewLogEntries.length - 1].film.metadata?.posterPath}`}
                              alt={reviewLogEntries[reviewLogEntries.length - 1].film.title}
                              loading="lazy"
                            />
                          ) : (
                            <span>{reviewLogEntries[reviewLogEntries.length - 1].film.title}</span>
                          )}
                        </div>
                        <p>{new Date(`${reviewLogEntries[reviewLogEntries.length - 1].date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</p>
                      </>
                    ) : (
                      <div className="review-milestone-poster is-empty" aria-hidden="true" />
                    )}
                  </article>
                </div>
              </section>
              )}

              {period === 'all-time' && (
                <section className="review-most-watched-section review-most-watched-all-time" aria-label="Most watched movies">
                  <h2>Most Watched Movies</h2>
                  {mostWatchedFilms.length > 0 ? (
                    <div className="review-most-watched-grid">
                      {mostWatchedFilms.map(({ film, watchCount }) => (
                        <article className="review-most-watched-card" key={film.key} title={film.title}>
                          <div className="review-milestone-poster">
                            {film.metadata?.posterPath ? (
                              <img
                                src={`https://image.tmdb.org/t/p/w342${film.metadata.posterPath}`}
                                alt={`Poster for ${film.title}`}
                                loading="lazy"
                              />
                            ) : (
                              <span>{film.title}</span>
                            )}
                          </div>
                          <h3 title={film.title}>{film.title}</h3>
                          <p>{watchCount === 2 ? 'Twice' : `${watchCount} times`}</p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="review-most-watched-empty">No films have been watched more than once in this period.</p>
                  )}
                </section>
              )}

              {period !== 'all-time' && renderRatingsComparisonSection()}

              {period === 'all-time' && renderRatingsComparisonSection()}

              {period !== 'all-time' && (
              <section className="review-most-watched-section" aria-label="Most watched films">
                <h2>Most Watched</h2>
                <div className="review-most-watched-grid">
                  {mostWatchedSlots.map((item, index) =>
                    item ? (
                      <article className="review-most-watched-card" key={item.film.key} title={item.film.title}>
                        <div className="review-milestone-poster">
                          {item.film.metadata?.posterPath ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w500${item.film.metadata.posterPath}`}
                              alt={item.film.title}
                              loading="lazy"
                            />
                          ) : (
                            <span>{item.film.title}</span>
                          )}
                        </div>
                        <p>{item.watchCount === 2 ? 'Twice' : `${item.watchCount} times`}</p>
                      </article>
                    ) : (
                      <div
                        className="review-milestone-poster is-empty"
                        key={`most-watched-empty-${index}`}
                        aria-hidden="true"
                      />
                    ),
                  )}
                </div>
              </section>
              )}

              {period !== 'all-time' && renderTasteSection()}

              {period !== 'all-time' && (
              <section className="review-breakdown-section" aria-label="Viewing breakdown">
                <div className="review-breakdown-heading">
                  <h2>Breakdown</h2>
                  <span aria-hidden="true" />
                </div>

                <div className="review-breakdown-pies">
                  <article className="review-breakdown-pie-card">
                    <h3>{period === 'all-time' ? 'Premieres vs Older' : `${period} Premieres vs Older`}</h3>
                    {periodFilms.length > 0 ? (
                      <>
                        <div
                          className="review-breakdown-pie"
                          role="img"
                          aria-label={`${premiereFilmCount} premieres and ${olderFilmCount} older films`}
                          style={{
                            background: `conic-gradient(#08d65b 0 ${(premiereFilmCount / periodFilms.length) * 100}%, #435466 ${(premiereFilmCount / periodFilms.length) * 100}% 100%)`,
                          }}
                        />
                        <div className="review-breakdown-legend">
                          <span><i className="is-premiere" />{period === 'all-time' ? 'Watched in release year' : 'Premieres'} <strong>{premiereFilmCount}</strong></span>
                          <span><i className="is-older" />Older films <strong>{olderFilmCount}</strong></span>
                        </div>
                      </>
                    ) : (
                      <p className="review-breakdown-empty">No films in this period.</p>
                    )}
                  </article>

                  <article className="review-breakdown-pie-card">
                    <h3>Watches vs Re-watches</h3>
                    {periodFilms.length > 0 ? (
                      <>
                        <div
                          className="review-breakdown-pie"
                          role="img"
                          aria-label={`${newWatchFilmCount} new watches and ${rewatchFilmCount} re-watched films`}
                          style={{
                            background: `conic-gradient(#08d65b 0 ${(newWatchFilmCount / periodFilms.length) * 100}%, #435466 ${(newWatchFilmCount / periodFilms.length) * 100}% 100%)`,
                          }}
                        />
                        <div className="review-breakdown-legend">
                          <span><i className="is-premiere" />Watches <strong>{newWatchFilmCount}</strong></span>
                          <span><i className="is-older" />Re-watches <strong>{rewatchFilmCount}</strong></span>
                        </div>
                      </>
                    ) : (
                      <p className="review-breakdown-empty">No films in this period.</p>
                    )}
                  </article>
                </div>

                <div className="review-ratings-breakdown">
                  <div className="review-ratings-chart" aria-label={`${period === 'all-time' ? 'All time' : period} ratings distribution`}>
                    {reviewRatingDistribution.map(({ rating, count }) => (
                      <div
                        className="review-ratings-column"
                        key={rating}
                        role="img"
                        aria-label={`${rating} star${rating === 1 ? '' : 's'}: ${count} film${count === 1 ? '' : 's'}`}
                        title={`${rating} / 5 · ${count} film${count === 1 ? '' : 's'}`}
                      >
                        <span
                          className="review-ratings-bar"
                          style={{ height: `${count ? Math.max(5, (count / reviewMaxRatingCount) * 100) : 0}%` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="review-ratings-scale" aria-hidden="true">
                    <span>★</span>
                    <span>★★★★★</span>
                  </div>
                  <p className="review-ratings-caption">
                    {period === 'all-time' ? 'ALL TIME' : period} RATINGS
                    <span>{ratedFilmCount} rated films</span>
                  </p>
                </div>
              </section>
              )}
              <section className="review-cast-section" aria-label="Cast members">
                <div className="review-taste-heading review-cast-heading">
                  <h2>Cast</h2>
                  <span className="review-taste-rule" aria-hidden="true" />
                  <div className="review-taste-tabs" role="tablist" aria-label="Cast ranking mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={castMode === 'most-watched'}
                      className={castMode === 'most-watched' ? 'active' : ''}
                      onClick={() => {
                        setCastMode('most-watched');
                        setCastVisibleCount(10);
                      }}
                    >
                      Most Watched
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={castMode === 'highest-rated'}
                      className={castMode === 'highest-rated' ? 'active' : ''}
                      onClick={() => {
                        setCastMode('highest-rated');
                        setCastVisibleCount(10);
                      }}
                    >
                      Highest Rated
                    </button>
                  </div>
                </div>

                {visibleCastMembers.length > 0 ? (
                  <>
                    <div className="review-cast-grid">
                      {visibleCastMembers.map((person) => (
                        <article className="review-cast-card" key={person.id}>
                          <div className="review-cast-portrait">
                            {person.profilePath ? (
                              <img
                                src={`https://image.tmdb.org/t/p/w185${person.profilePath}`}
                                alt={person.name}
                                loading="lazy"
                              />
                            ) : (
                              <span aria-hidden="true">
                                {person.name
                                  .split(/\s+/)
                                  .slice(0, 2)
                                  .map((part) => part[0] ?? '')
                                  .join('')}
                              </span>
                            )}
                          </div>
                          <h3 title={person.name}>{person.name}</h3>
                          {castMode === 'most-watched' ? (
                            <p>{person.filmCount} films</p>
                          ) : (
                            <p>
                              ★ {person.averageRating.toFixed(2)} · {person.ratedFilmCount} films
                            </p>
                          )}
                        </article>
                      ))}
                    </div>

                    {castVisibleCount < castMembers.length && (
                      <button
                        type="button"
                        className="review-cast-show-more"
                        onClick={() =>
                          setCastVisibleCount((count) =>
                            Math.min(count + 30, castMembers.length),
                          )
                        }
                      >
                        Show More
                      </button>
                    )}
                  </>
                ) : (
                  <p className="review-cast-empty">
                    {periodFilms.some((film) => !film.metadata?.cast)
                      ? 'Cast details will appear after TMDB metadata is refreshed. Re-import your Letterboxd ZIP to enrich existing films.'
                      : castMode === 'highest-rated'
                        ? 'No cast members have at least two rated films in this period.'
                        : 'No cast members appear in at least two films in this period.'}
                  </p>
                )}
              </section>
              <section className="review-directors-section" aria-label="Directors">
                <div className="review-taste-heading review-directors-heading">
                  <h2>Directors</h2>
                  <span className="review-taste-rule" aria-hidden="true" />
                  <div className="review-taste-tabs" role="tablist" aria-label="Director ranking mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={directorMode === 'most-watched'}
                      className={directorMode === 'most-watched' ? 'active' : ''}
                      onClick={() => {
                        setDirectorMode('most-watched');
                        setDirectorVisibleCount(10);
                      }}
                    >
                      Most Watched
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={directorMode === 'highest-rated'}
                      className={directorMode === 'highest-rated' ? 'active' : ''}
                      onClick={() => {
                        setDirectorMode('highest-rated');
                        setDirectorVisibleCount(10);
                      }}
                    >
                      Highest Rated
                    </button>
                  </div>
                </div>

                {visibleDirectors.length > 0 ? (
                  <>
                    <div className="review-directors-grid">
                      {visibleDirectors.map((director) => (
                        <article className="review-directors-card" key={director.id}>
                          <div className="review-directors-portrait">
                            {director.profilePath ? (
                              <img
                                src={`https://image.tmdb.org/t/p/w185${director.profilePath}`}
                                alt={director.name}
                                loading="lazy"
                              />
                            ) : (
                              <span aria-hidden="true">
                                {director.name
                                  .split(/\s+/)
                                  .slice(0, 2)
                                  .map((part) => part[0] ?? '')
                                  .join('')}
                              </span>
                            )}
                          </div>
                          <h3 title={director.name}>{director.name}</h3>
                          {directorMode === 'most-watched' ? (
                            <p>{director.filmCount} films</p>
                          ) : (
                            <p>
                              ★ {director.averageRating.toFixed(2)} · {director.ratedFilmCount} films
                            </p>
                          )}
                        </article>
                      ))}
                    </div>

                    {directorVisibleCount < directors.length && (
                      <button
                        type="button"
                        className="review-directors-show-more"
                        onClick={() =>
                          setDirectorVisibleCount((count) =>
                            Math.min(count + 30, directors.length),
                          )
                        }
                      >
                        Show More
                      </button>
                    )}
                  </>
                ) : (
                  <p className="review-directors-empty">
                    {periodFilms.some((film) => !film.metadata?.directorProfiles)
                      ? 'Director profiles will appear after TMDB metadata is refreshed. Re-import your Letterboxd ZIP to update existing films.'
                      : directorMode === 'highest-rated'
                        ? 'No directors have at least two rated films in this period.'
                        : 'No directors appear in at least two films in this period.'}
                  </p>
                )}
              </section>


              <WorldMap films={periodFilms} period={period} />
            </div>
          )}
        </div>
      </div>

      <footer className="credits">
        <a
          href="https://www.themoviedb.org/"
          target="_blank"
          rel="noreferrer"
          aria-label="The Movie Database (TMDB)"
        >
          <img
            src={`${import.meta.env.BASE_URL}tmdb.svg`}
            alt="The Movie Database (TMDB)"
          />
        </a>
        <p>
          This product uses the TMDB API but is not endorsed or certified by
          TMDB.
        </p>
      </footer>
    </main>
  );
}

export default App;