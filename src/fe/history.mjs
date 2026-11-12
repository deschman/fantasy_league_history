export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        if (!quoted && field !== "") throw new Error("Invalid quote in CSV field");
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unclosed quoted CSV field");
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (rows.length === 0) throw new Error("CSV has no header");
  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV headers");
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns`);
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
}

function required(row, field) {
  if (typeof row[field] !== "string" || row[field].trim() === "") {
    throw new Error(`Missing ${field} in season ${row.season || "unknown"}`);
  }
  return row[field].trim();
}

function numeric(row, field, optional = false) {
  if (optional && row[field] === "") return null;
  const value = Number(required(row, field));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field} in ${row.season}`);
  return value;
}

function teamKey(season, team) {
  return `${season}:${team.trim()}`;
}

export function buildHistory(sources) {
  const identities = new Map();
  const namesById = new Map();
  const orderedSources = [...sources].sort((a, b) => a.platform.localeCompare(b.platform));
  // Later Sleeper seasons provide the most recent display name for each stable ID.
  for (const source of orderedSources) {
    if (source.platform !== "sleeper") continue;
    for (const mapping of [...source.crosswalk].sort((a, b) => Number(a.season) - Number(b.season))) {
      const owner = required(mapping, "owner");
      const id = required(mapping, "owner_id");
      const existing = identities.get(owner);
      if (existing && existing !== id) throw new Error(`Ambiguous Sleeper username: ${owner}`);
      identities.set(owner, id);
      namesById.set(id, owner);
    }
  }
  const identity = (name) => {
    const id = identities.get(name);
    return { id: id ? `sleeper:${id}` : `owner:${name}`, name: id ? namesById.get(id) : name };
  };
  const history = [];
  const seen = new Set();
  for (const source of sources) {
    const mappings = new Map();
    for (const mapping of source.crosswalk) {
      const key = teamKey(required(mapping, "season"), required(mapping, "team"));
      if (mappings.has(key)) throw new Error(`Duplicate crosswalk entry: ${key}`);
      mappings.set(key, mapping);
    }
    for (const row of source.standings) {
      const season = numeric(row, "season");
      const team = required(row, "team");
      const key = teamKey(season, team);
      if (seen.has(key)) throw new Error(`Duplicate team-season: ${key}`);
      seen.add(key);
      const mapping = mappings.get(key);
      if (!mapping) throw new Error(`Missing ${source.platform} crosswalk entry: ${key}`);
      const owner = identity(required(mapping, "owner"));
      const franchise = mapping.inheriting_owner?.trim() ? identity(mapping.inheriting_owner.trim()) : owner;
      history.push({
        season, team, platform: source.platform, owner, franchise,
        wins: numeric(row, "wins"), losses: numeric(row, "losses"), ties: numeric(row, "ties"),
        pointsFor: numeric(row, "points_for"), pointsAgainst: numeric(row, "points_against"),
        regularRank: numeric(row, "regular_season_rank", true),
        finalRank: numeric(row, "final_rank", true),
      });
    }
  }
  if (!history.length) throw new Error("No standings found");
  const slots = new Set();
  for (const row of history) {
    const slot = `${row.season}:${row.franchise.id}`;
    if (slots.has(slot)) throw new Error(`Multiple teams for franchise in ${row.season}: ${row.franchise.name}`);
    slots.add(slot);
  }
  return history.sort((a, b) => a.season - b.season || (a.regularRank ?? Infinity) - (b.regularRank ?? Infinity));
}

export function aggregate(history, mode = "franchise") {
  const groups = new Map();
  for (const row of history) {
    const person = row[mode];
    if (!person) throw new Error(`Unknown history mode: ${mode}`);
    if (!groups.has(person.id)) {
      groups.set(person.id, { id: person.id, name: person.name, wins: 0, losses: 0, ties: 0,
        pointsFor: 0, pointsAgainst: 0, titles: 0, podiums: 0, finishes: [], seasons: [] });
    }
    const group = groups.get(person.id);
    for (const key of ["wins", "losses", "ties", "pointsFor", "pointsAgainst"]) group[key] += row[key];
    group.titles += row.finalRank === 1 ? 1 : 0;
    group.podiums += row.finalRank !== null && row.finalRank <= 3 ? 1 : 0;
    if (row.finalRank !== null) group.finishes.push(row.finalRank);
    group.seasons.push(row);
  }
  return [...groups.values()].map((group) => {
    const games = group.wins + group.losses + group.ties;
    return { ...group, games, winPercentage: games ? (group.wins + group.ties / 2) / games : 0,
      averageFinish: group.finishes.length ? group.finishes.reduce((a, b) => a + b, 0) / group.finishes.length : null,
      seasons: group.seasons.sort((a, b) => b.season - a.season) };
  });
}

export function sortStandings(groups, metric = "wins") {
  const allowed = ["wins", "winPercentage", "pointsFor", "pointsAgainst", "titles", "podiums", "averageFinish"];
  if (!allowed.includes(metric)) throw new Error(`Unknown standings metric: ${metric}`);
  return [...groups].sort((a, b) => {
    if (metric === "averageFinish") {
      const difference = (a[metric] ?? Infinity) - (b[metric] ?? Infinity);
      if (difference && !Number.isNaN(difference)) return difference;
    } else if (a[metric] !== b[metric]) return b[metric] - a[metric];
    return b.wins - a.wins || b.winPercentage - a.winPercentage || b.pointsFor - a.pointsFor || a.name.localeCompare(b.name);
  });
}

export function seasonPodiums(history) {
  const seasons = [...new Set(history.map((row) => row.season))].sort((a, b) => b - a);
  return seasons.map((season) => {
    const teams = history.filter((row) => row.season === season);
    return { season, platform: teams[0].platform,
      podium: [1, 2, 3].map((rank) => teams.find((row) => row.finalRank === rank) ?? null), teams };
  });
}
