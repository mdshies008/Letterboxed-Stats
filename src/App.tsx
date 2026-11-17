import { useEffect, useState, type ChangeEvent } from 'react';
import type { Film } from './types';
import { readLetterboxdZip } from './lib/readLetterboxdZip';
import { parseLetterboxd } from './lib/parseLetterboxd';
import { loadLibrary, saveLibrary } from './lib/libraryStorage';
import {
  getAvailableYears,
  getFilmsForPeriod,
  getPeriodWatchCount,
  getTopRatedDirector,
  getTopWatchedCountries,
  getTopWatchedFilms,
} from './lib/stats';
import { findFilmMetadata } from './lib/enrichFilm';
import {
  getTmdbMovieMetadata,
  searchTmdbMovie,
  type TmdbSearchResult,
} from './lib/tmdb';
import './App.css';

type FilmSort = 'title' | 'rating-high' | 'rating-low' | 'year-new' | 'year-old';

function formatWatchTime(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remainingMinutes}m`;
  return `${remainingMinutes}m`;
}

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
  const [period, setPeriod] = useState('all-time');

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
          film.metadata.posterPath === undefined),
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

        const metadata = await findFilmMetadata(film);

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
  const watchedFilms = films.filter((film) => film.watched);
  const ratedFilms = films.filter((film) => film.rating !== null);

  const averageRating = ratedFilms.length
    ? ratedFilms.reduce((total, film) => total + (film.rating ?? 0), 0) /
      ratedFilms.length
    : null;

  const filmsWithRuntime = watchedFilms.filter(
    (film) => typeof film.metadata?.runtimeMinutes === 'number',
  );

  const totalWatchMinutes = filmsWithRuntime.reduce(
    (total, film) =>
      total +
      (film.metadata?.runtimeMinutes ?? 0) *
        getPeriodWatchCount(film, 'all-time'),
    0,
  );

  const ratingDistribution = Array.from({ length: 10 }, (_, index) => {
    const rating = (index + 1) / 2;
    const count = ratedFilms.filter(
      (film) => Math.round((film.rating ?? 0) * 2) === index + 1,
    ).length;

    return { rating, count };
  });

  const maxRatingCount = Math.max(
    1,
    ...ratingDistribution.map((bucket) => bucket.count),
  );

  const topRatedFilms = [...ratedFilms]
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
    .slice(0, 5);

  const periodFilms = getFilmsForPeriod(films, period);
  const periodViewCount = periodFilms.reduce(
    (total, film) => total + getPeriodWatchCount(film, period),
    0,
  );
  const topWatchedFilms = getTopWatchedFilms(films, period);
  const topRatedDirector = getTopRatedDirector(films, period);
  const topWatchedCountries = getTopWatchedCountries(films, period);

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

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="app-breadcrumb">
          YOUR MOVIE ARCHIVE <span>/</span>{' '}
          {activeTab === 'films'
            ? 'YOUR FILM ARCHIVE'
            : activeTab === 'review'
              ? 'YOUR YEAR IN REVIEW'
              : 'YOUR OVERVIEW'}
        </p>

        <div className="header-actions">
          <label htmlFor="header-period">Viewing period</label>
          <select
            id="header-period"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          >
            <option value="all-time">All time</option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>

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
            <span className="sidebar-brand-icon" aria-hidden="true">
              ▣
            </span>
            <span>
              <strong>My Movie Archive</strong>
              <small>Your cinematic history</small>
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

          <section className="sidebar-promo">
            <span aria-hidden="true">✳</span>
            <h2>It’s all about your stories.</h2>
            <p>One Letterboxd export. Your film history in one place.</p>
            <button type="button" onClick={() => setActiveTab('dashboard')}>
              Analyze my films <span aria-hidden="true">→</span>
            </button>
          </section>

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

              {films.length > 0 && (
                <section className="dashboard-overview">
                  <div className="section-heading">
                    <div>
                      <p className="wrapped-eyebrow">
                        YOUR LIBRARY AT A GLANCE
                      </p>
                      <h2>General overview</h2>
                    </div>
                  </div>

                  <div className="dashboard-stats">
                    <article className="dashboard-stat">
                      <span>Films watched</span>
                      <strong>{watchedFilms.length}</strong>
                    </article>
                    <article className="dashboard-stat">
                      <span>Average rating</span>
                      <strong>
                        {averageRating !== null
                          ? `${averageRating.toFixed(2)} / 5`
                          : '—'}
                      </strong>
                    </article>
                    <article className="dashboard-stat">
                      <span>Estimated watch time</span>
                      <strong>
                        {filmsWithRuntime.length > 0
                          ? formatWatchTime(totalWatchMinutes)
                          : '—'}
                      </strong>
                      <small>
                        Runtime data for {filmsWithRuntime.length} of{' '}
                        {watchedFilms.length} watched films
                      </small>
                    </article>
                    <article className="dashboard-stat">
                      <span>Films rated</span>
                      <strong>{ratedFilms.length}</strong>
                    </article>
                  </div>

                  <div className="dashboard-content-grid">
                    <article className="dashboard-card rating-card">
                      <h3>Rating distribution</h3>
                      {ratedFilms.length > 0 ? (
                        <div className="rating-chart">
                          <span
                            className="rating-chart-endpoint"
                            aria-label="One star"
                          >
                            ★
                          </span>

                          <div className="rating-chart-bars">
                            {ratingDistribution.map(({ rating, count }) => (
                              <div
                                className="rating-column"
                                key={rating}
                                tabIndex={0}
                                aria-label={`${count} ${
                                  count === 1 ? 'film' : 'films'
                                } rated ${rating.toFixed(1)} out of 5`}
                                data-tooltip={`${count} ${
                                  count === 1 ? 'film' : 'films'
                                } · ${rating.toFixed(1)} / 5`}
                              >
                                <span
                                  className="rating-bar-fill"
                                  style={{
                                    height: `${(count / maxRatingCount) * 100}%`,
                                  }}
                                />
                              </div>
                            ))}
                          </div>

                          <span
                            className="rating-chart-endpoint"
                            aria-label="Five stars"
                          >
                            ★★★★★
                          </span>
                        </div>
                      ) : (
                        <p>No ratings found in this library yet.</p>
                      )}
                    </article>

                    <article className="dashboard-card">
                      <h3>Top-rated films</h3>
                      {topRatedFilms.length > 0 ? (
                        <ol className="dashboard-top-films">
                          {topRatedFilms.map((film) => (
                            <li key={film.key}>
                              <span>
                                {film.title} ({film.year ?? 'year unknown'})
                              </span>
                              <strong>{film.rating?.toFixed(1)} / 5</strong>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>No rated films were found.</p>
                      )}
                    </article>
                  </div>

                  <p className="dashboard-note">
                    Watch time is estimated from available TMDB runtimes and
                    logged viewings. Films without runtime data are not
                    included.
                  </p>
                </section>
              )}
            </div>
          )}

          {activeTab === 'films' && (
            <section className="films-page">
              <div className="films-heading">
                <div>
                  <p className="wrapped-eyebrow">02 / THE ARCHIVE</p>
                  <h1>Every frame you collected</h1>
                  <p>Search, sort, and rediscover the films that make up your story.</p>
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
              {films.length > 0 ? (
                <section className="wrapped-section">
                  <div className="wrapped-header">
                    <div>
                      <p className="wrapped-eyebrow">YOUR FILMS, IN REVIEW</p>
                      <h1>Year in Review</h1>
                      <p>Your viewing highlights for the selected period.</p>
                    </div>

                    <div className="wrapped-controls">
                      <label htmlFor="review-period">Viewing period</label>
                      <select
                        id="review-period"
                        value={period}
                        onChange={(event) => setPeriod(event.target.value)}
                      >
                        <option value="all-time">All time</option>
                        {years.map((year) => (
                          <option key={year} value={year}>
                            {year}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="wrapped-metrics">
                    <div className="wrapped-metric">
                      <span>Films watched</span>
                      <strong>{periodFilms.length}</strong>
                    </div>
                    <div className="wrapped-metric">
                      <span>Logged viewings</span>
                      <strong>{periodViewCount}</strong>
                    </div>
                  </div>

                  <div className="wrapped-grid">
                    <article className="wrapped-card wrapped-card-films">
                      <h2>Most-watched films</h2>
                      {topWatchedFilms.length > 0 ? (
                        <ol className="wrapped-top-films">
                          {topWatchedFilms.map(({ film, watchCount }) => (
                            <li key={film.key}>
                              {film.metadata?.posterPath ? (
                                <img
                                  className="wrapped-film-poster"
                                  src={`https://image.tmdb.org/t/p/w185${film.metadata.posterPath}`}
                                  alt={`Poster for ${film.title}`}
                                  loading="lazy"
                                />
                              ) : (
                                <div className="wrapped-film-poster wrapped-poster-placeholder">
                                  No poster
                                </div>
                              )}

                              <div className="wrapped-film-copy">
                                <strong>{film.title}</strong>
                                <span>
                                  {watchCount}{' '}
                                  {watchCount === 1 ? 'viewing' : 'viewings'}
                                  {film.rating !== null &&
                                    ` · ${film.rating.toFixed(1)} / 5`}
                                  {film.metadata?.countries.length
                                    ? ` · ${film.metadata.countries.join(', ')}`
                                    : ''}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>
                          No dated Diary entries for this period yet. All-time
                          includes films marked watched without a diary date.
                        </p>
                      )}
                    </article>

                    <article className="wrapped-card">
                      <h2>Highest-rated director</h2>
                      {topRatedDirector ? (
                        <p className="wrapped-highlight">
                          <strong>{topRatedDirector.name}</strong>
                          <span>
                            {topRatedDirector.averageRating.toFixed(2)} / 5
                            across {topRatedDirector.ratedFilmCount} rated films
                          </span>
                        </p>
                      ) : (
                        <p>
                          No director has at least two rated films in this
                          period yet.
                        </p>
                      )}
                    </article>

                    <article className="wrapped-card">
                      <h2>Most-watched countries</h2>
                      {topWatchedCountries.length > 0 ? (
                        <ol className="wrapped-country-list">
                          {topWatchedCountries.map((country) => (
                            <li key={country.name}>
                              <strong>{country.name}</strong>
                              <span>
                                {country.watchCount} associated viewings
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>
                          No country data for this period yet. Enrich the
                          library first.
                        </p>
                      )}
                    </article>
                  </div>
                </section>
              ) : (
                <section className="review-empty">
                  <h2>Your Year in Review will appear here</h2>
                  <p>Add your Letterboxd data from Overview.</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('dashboard')}
                  >
                    Go to Overview
                  </button>
                </section>
              )}
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