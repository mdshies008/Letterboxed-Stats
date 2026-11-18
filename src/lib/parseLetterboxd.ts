import type { Film } from '../types';
import type { LetterboxdRows } from './readLetterboxdZip';

function getColumn(row: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = Object.keys(row).find(
    (header) => header.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted,
  );
  return key ? row[key] : undefined;
}

function parseYear(value: string | undefined): number | null {
  const year = Number(value?.trim());
  return Number.isInteger(year) && year >= 1870 && year <= 2100 ? year : null;
}

function parseRating(value: string | undefined): number | null {
  const rating = Number(value?.trim());
  return Number.isFinite(rating) && rating >= 0.5 && rating <= 5
    ? Math.round(rating * 2) / 2
    : null;
}

function parseDate(value: string | undefined): string | null {
  const date = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

function makeKey(title: string, year: number | null): string {
  return `${title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}|${year ?? ''}`;
}

export function parseLetterboxd(rows: LetterboxdRows): Film[] {
  const films = new Map<string, Film>();
  const watchedListDates = new Map<string, Set<string>>();

  function getFilm(row: Record<string, string>): Film | null {
    const title = (getColumn(row, 'Name') || getColumn(row, 'Title') || '').trim();
    if (!title) return null;

    const year = parseYear(getColumn(row, 'Year'));
    const key = makeKey(title, year);
    let film = films.get(key);

    if (!film) {
      film = {
        key,
        title,
        year,
        rating: null,
        ratingDate: null,
        watched: false,
        watchedDates: [],
        loggedDates: [],
        diaryEntryCount: 0,
        rewatches: 0,
        liked: false,
        watchlisted: false,
        sources: ['letterboxd'],
      };
      films.set(key, film);
    }

    return film;
  }

  // Letterboxd's watched.csv Date records when the film was marked watched.
  // Keep it as a fallback for films that have no dated diary viewing.
  for (const row of rows.watched) {
    const film = getFilm(row);
    if (!film) continue;

    film.watched = true;
    const markedWatchedDate = parseDate(getColumn(row, 'Date'));
    if (markedWatchedDate) {
      const dates = watchedListDates.get(film.key) ?? new Set<string>();
      dates.add(markedWatchedDate);
      watchedListDates.set(film.key, dates);
    }
  }

  for (const row of rows.diary) {
    const film = getFilm(row);
    if (!film) continue;

    film.watched = true;
    film.diaryEntryCount = (film.diaryEntryCount ?? 0) + 1;

    // Watched Date is the date the viewing happened. Diary Date is when the
    // diary record was added, so it must not set the viewing period.
    const watchedDate = parseDate(getColumn(row, 'Watched Date'));
    if (watchedDate) film.watchedDates.push(watchedDate);

    const loggedDate = parseDate(getColumn(row, 'Date'));
    if (loggedDate) film.loggedDates?.push(loggedDate);

    // Ratings are loaded only from ratings.csv below. A rating added later
    // to a diary row must not change the rating source or viewing date.
    if (getColumn(row, 'Rewatch')?.trim().toLowerCase() === 'yes') {
      film.rewatches += 1;
    }

    if (getColumn(row, 'Like')?.trim().toLowerCase() === 'yes') {
      film.liked = true;
    }
  }

  for (const row of rows.ratings) {
    const film = getFilm(row);
    if (!film) continue;
    film.watched = true;
    const rating = parseRating(getColumn(row, 'Rating'));
    if (rating !== null) film.rating = rating;
  }

  // Prefer the diary's actual Watched Date when available. Only fall back to
  // watched.csv's Date for films whose diary has no dated viewing.
  for (const film of films.values()) {
    if (film.watchedDates.length > 0) continue;
    const markedWatchedDates = watchedListDates.get(film.key);
    if (markedWatchedDates) film.watchedDates.push(...markedWatchedDates);
  }

  for (const row of rows.watchlist) {
    const film = getFilm(row);
    if (film) film.watchlisted = true;
  }

  for (const row of rows.likes) {
    const film = getFilm(row);
    if (film) film.liked = true;
  }

  return [...films.values()].sort((a, b) => a.title.localeCompare(b.title));
}