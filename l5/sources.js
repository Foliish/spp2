import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { setTimeout as wait } from "node:timers/promises";

const lensUrl = "https://files.grouplens.org/datasets/movielens/ml-latest-small.zip";
const mazeUrl = "https://api.tvmaze.com/shows";
const sfUrl = "https://data.sfgov.org/resource/yitu-d5am.json";
const intYear = value => Number(String(value ?? "").match(/\b\d{4}\b/)?.[0]) || null;

async function download(url, read) {
  for (let attempt = 0; ; attempt++) {
    let error;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "SPP-Lab5 educational film catalog" } });
      if (response.ok) return await read(response);
      error = new Error("HTTP " + response.status);
    } catch (cause) {
      error = cause;
    }
    if (attempt === 2) throw error;
    await wait(800 * (attempt + 1));
  }
}

async function movieLens() {
  const bytes = await download(process.env.MOVIELENS_URL || lensUrl, r => r.arrayBuffer());
  const archive = new AdmZip(Buffer.from(bytes));
  const csv = name => parse(archive.readAsText("ml-latest-small/" + name + ".csv"), { columns: true });
  const stats = new Map();
  for (const row of csv("ratings")) {
    const values = stats.get(row.movieId) || [0, 0];
    values[0] += Number(row.rating);
    values[1]++;
    stats.set(row.movieId, values);
  }
  const imdb = new Map(csv("links").map(row => [row.movieId, row.imdbId]));
  return csv("movies").map(row => {
    const parts = row.title.match(/^(.*)\s+\((\d{4})\)\s*$/);
    const [sum, count] = stats.get(row.movieId) || [0, 0];
    return { id: "MOVIELENS:" + row.movieId, title: (parts?.[1] || row.title).trim(),
      year: intYear(parts?.[2]), kind: "MOVIE", genres: row.genres.split("|").filter(x => x !== "(no genres listed)"),
      rating: count ? Math.round(sum / count * 20) / 10 : null,
      url: imdb.get(row.movieId) ? "https://www.imdb.com/title/tt" + imdb.get(row.movieId) + "/" : null,
      details: { ratingCount: count } };
  });
}

async function tvMaze() {
  const pages = [0, 1, 2, 3, 4, 5].map(page => {
    const url = new URL(process.env.TVMAZE_URL || mazeUrl);
    url.searchParams.set("page", page);
    return download(url, r => r.json());
  });
  return (await Promise.all(pages)).flat().map(row => ({
    id: "TVMAZE:" + row.id, title: row.name, year: intYear(row.premiered), kind: "SERIES",
    genres: row.genres, rating: row.rating?.average, url: row.url,
    details: { language: row.language, network: row.network?.name || row.webChannel?.name,
      country: row.network?.country?.name || row.webChannel?.country?.name, status: row.status },
  }));
}

async function dataSF() {
  const url = new URL(process.env.DATASF_URL || sfUrl);
  url.searchParams.set("$select", ":id,title,release_year,locations,director,actor_1,actor_2,actor_3,analysis_neighborhood");
  url.searchParams.set("$where", "locations IS NOT NULL");
  url.searchParams.set("$order", ":id");
  url.searchParams.set("$limit", "2000");
  const rows = await download(url, r => r.json());
  return rows.map(row => ({
    id: "DATASF:" + row[":id"], title: row.title, year: intYear(row.release_year), kind: "LOCATION",
    genres: [], url: null, details: { location: row.locations, neighborhood: row.analysis_neighborhood,
      director: row.director, cast: [row.actor_1, row.actor_2, row.actor_3].filter(Boolean) },
  }));
}

export const sources = [
  { id: "MOVIELENS", name: "MovieLens", minimum: 9500, load: movieLens,
    url: "https://www.grouplens.org/datasets/movielens/latest/",
    publisher: { name: "GroupLens Research", url: "https://www.grouplens.org/" } },
  { id: "TVMAZE", name: "TVmaze", minimum: 1000, load: tvMaze, url: "https://www.tvmaze.com/api",
    publisher: { name: "TVmaze", url: "https://www.tvmaze.com/" } },
  { id: "DATASF", name: "DataSF · Film Locations", minimum: 500, load: dataSF,
    url: "https://data.sfgov.org/Culture-and-Recreation/Film-Locations-in-San-Francisco/yitu-d5am",
    publisher: { name: "City and County of San Francisco", url: "https://www.sf.gov/" } },
];
