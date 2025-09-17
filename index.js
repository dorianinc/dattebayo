const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

// ---------------- Manifest ----------------
const manifest = {
  id: "org.example.dattebayo",
  version: "1.2.0",
  name: "Dattebayo",
  description:
    "Dattebayo pulls anime catalogs directly from AniList, including Trending Now and Popular This Season lists, with search and meta info.",
  resources: ["catalog", "meta"],
  types: ["anime"],
  idPrefixes: ["anilist"],
  logo: "https://i.ibb.co/xqzS72WY/dattebayo-logo.png", // <-- working direct link
  catalogs: [
    { type: "anime", id: "anilist-trending",       name: "Trending Now (AniList)",        extra: [{ name: "skip" }] },
    { type: "anime", id: "anilist-popular-season", name: "Popular This Season (AniList)", extra: [{ name: "skip" }] },
    { type: "anime", id: "anilist-search",         name: "Search AniList",                extra: [{ name: "search", isRequired: true }, { name: "skip" }] }
  ]
};

const builder = new addonBuilder(manifest);

// ---------------- AniList Client ----------------
const ANILIST_ENDPOINT = "https://graphql.anilist.co";

async function gql(query, variables = {}) {
  const res = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      // optional but nice; helps AniList identify your client
      "User-Agent": "Dattebayo/1.2 (+https://github.com/your/repo)"
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AniList ${res.status}: ${err}`);
  }
  return res.json();
}

function getCurrentSeasonYear(d = new Date()) {
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  if (m <= 3) return { season: "WINTER", year: y };
  if (m <= 6) return { season: "SPRING", year: y };
  if (m <= 9) return { season: "SUMMER", year: y };
  return { season: "FALL", year: y };
}

function pageFromSkip(skip = 0, perPage = 50) {
  const s = Number.isFinite(skip) ? skip : 0;
  return Math.floor(s / perPage) + 1;
}

// ---- Queries ----
async function searchAniList({ search, perPage = 20, page = 1 }) {
  const query = `
    query ($search: String!, $perPage: Int, $page: Int) {
      Page(page: $page, perPage: $perPage) {
        media(search: $search, type: ANIME, format_not_in: [MOVIE]) {
          id
          title { romaji english native }
          format
          seasonYear
          episodes
          coverImage { large }
          siteUrl
        }
      }
    }`;
  const { data } = await gql(query, { search, perPage, page });
  return data.Page.media || [];
}

async function getAniListById(id) {
  const query = `
    query ($id: Int!) {
      Media(id: $id) {
        id
        type
        title { romaji english native }
        description(asHtml: false)
        format
        status
        season
        seasonYear
        episodes
        duration
        genres
        averageScore
        coverImage { large extraLarge }
        bannerImage
        siteUrl
      }
    }`;
  const { data } = await gql(query, { id });
  return data.Media;
}

async function getTrendingSeries({ perPage = 50, page = 1 }) {
  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: TRENDING_DESC, format_not_in: [MOVIE]) {
          id
          title { romaji english native }
          format
          seasonYear
          episodes
          coverImage { large }
          siteUrl
        }
      }
    }`;
  const { data } = await gql(query, { page, perPage });
  return data.Page.media || [];
}

async function getPopularThisSeasonSeries({ season, seasonYear, perPage = 50, page = 1 }) {
  const query = `
    query ($page: Int, $perPage: Int, $season: MediaSeason!, $seasonYear: Int!) {
      Page(page: $page, perPage: $perPage) {
        media(
          type: ANIME
          season: $season
          seasonYear: $seasonYear
          sort: POPULARITY_DESC
          format_not_in: [MOVIE]
        ) {
          id
          title { romaji english native }
          format
          seasonYear
          episodes
          coverImage { large }
          siteUrl
        }
      }
    }`;
  const variables = { page, perPage, season, seasonYear };
  const { data } = await gql(query, variables);
  return data.Page.media || [];
}

// ---------------- Mappers ----------------
function titlePick(t) {
  return t?.english || t?.romaji || t?.native || "Untitled";
}

function mapAniListToMetaLite(m) {
  return {
    id: `anilist:${m.id}`,
    type: "anime",
    name: titlePick(m.title),
    poster: m.coverImage?.large,
    posterShape: "regular",
    year: m.seasonYear,
  };
}

function mapAniListToMetaFull(m) {
  const meta = {
    id: `anilist:${m.id}`,
    type: "anime",
    name: titlePick(m.title),
    description: m.description,
    poster: m.coverImage?.extraLarge || m.coverImage?.large,
    background: m.bannerImage,
    genres: m.genres,
    imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined,
    year: m.seasonYear,
    website: m.siteUrl,
  };
  const epCount = Number.isFinite(m.episodes) && m.episodes > 0 ? m.episodes : 12;
  meta.videos = Array.from({ length: epCount }, (_, i) => {
    const ep = i + 1;
    return {
      id: `anilist:${m.id}:1:${ep}`,
      season: 1,
      episode: ep,
      title: `S1E${ep}`,
    };
  });
  return meta;
}

// ---------------- Simple Cache ----------------
const cache = new Map();
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { cache.delete(key); return null; }
  return hit.val;
}
function setCache(key, val, ms = 60_000) {
  cache.set(key, { val, exp: Date.now() + ms });
}

// ---------------- Catalog Handler ----------------
builder.defineCatalogHandler(async ({ id, extra }) => {
  const skip = Number(extra?.skip || 0);
  const perPage = 50;
  const page = pageFromSkip(skip, perPage);

  if (id === "anilist-trending") {
    const cacheKey = `trending:${page}`;
    const cached = getCache(cacheKey);
    if (cached) return { metas: cached };
    const results = await getTrendingSeries({ perPage, page });
    const metas = results.map(mapAniListToMetaLite);
    setCache(cacheKey, metas, 60_000);
    return { metas };
  }

  if (id === "anilist-popular-season") {
    const { season, year } = getCurrentSeasonYear();
    const cacheKey = `popularSeason:${season}-${year}:page=${page}`;
    const cached = getCache(cacheKey);
    if (cached) return { metas: cached };
    const results = await getPopularThisSeasonSeries({ season, seasonYear: year, perPage, page });
    const metas = results.map(mapAniListToMetaLite);
    setCache(cacheKey, metas, 60_000);
    return { metas };
  }

  if (id === "anilist-search") {
    const query = ((extra && (extra.search || extra.searchText)) || "").trim();
    if (!query) return { metas: [] };
    const cacheKey = `search:${query}:page=${page}`;
    const cached = getCache(cacheKey);
    if (cached) return { metas: cached };
    const results = await searchAniList({ search: query, perPage, page });
    const metas = results.map(mapAniListToMetaLite);
    setCache(cacheKey, metas, 30_000);
    return { metas };
  }

  return { metas: [] };
});

// ---------------- Meta Handler ----------------
builder.defineMetaHandler(async ({ id }) => {
  if (!id.startsWith("anilist:")) return { meta: null };
  const [, raw] = id.split(":");
  const anilistId = parseInt(raw, 10);
  if (!Number.isFinite(anilistId)) return { meta: null };

  const cacheKey = `meta:${anilistId}`;
  const cached = getCache(cacheKey);
  if (cached) return { meta: cached };

  const m = await getAniListById(anilistId);
  if (!m) return { meta: null };

  const meta = mapAniListToMetaFull(m);
  setCache(cacheKey, meta, 60_000);
  return { meta };
});

// ---------------- Serve HTTP ----------------
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Dattebayo add-on running on http://localhost:${PORT}/manifest.json`);
