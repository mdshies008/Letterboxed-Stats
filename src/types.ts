export type ImportSource = 'letterboxd';

export interface Film{
    key: string;
    title: string;
    year: number | null;
    rating: number | null; // normalized a 0-5 scale
    ratingDate: string | null;
    watchedDates: string[];
    loggedDates?: string[];
    diaryEntryCount?: number;
    rewatches: number;
    liked: boolean;
    sources: ImportSource[];
    metadata?: FilmMetadata;
    watchlisted: boolean;
    watched: boolean;
}

export interface FilmCastMember {
    id: number;
    name: string;
    profilePath: string | null;
}

export interface FilmMetadata {
    countries: string[];
    genres: string[];
    directors: string[];
    runtimeMinutes: number | null;
    tmdbId?: number;
    posterPath?: string | null;
    originalLanguage?: string | null;
    cast?: FilmCastMember[];
    directorProfiles?: FilmCastMember[];
    tmdbRating?: number;
    tmdbVoteCount?: number;
    tmdbPopularity?: number;
    releaseDate?: string | null;
}