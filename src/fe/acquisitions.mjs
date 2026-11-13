export const SOURCE_LABELS = {
  draft: "Draft", trade: "Trade", freeAgency: "Free agency", unknown: "Unknown",
};
export const SOURCE_REASONS = {
  verified: "Acquisition recorded before this start",
  timing: "Multiple possible acquisitions within the NFL kickoff window",
  untraced: "No unambiguous acquisition found for this roster",
  commissioner: "Commissioner move does not identify draft, trade, or free agency",
  interval: "Unique acquisition consistent with ESPN's proposal-to-completion interval",
  migration: "Original ESPN acquisition carried through the Sleeper roster import",
};

function startKey(season, week, team, player) {
  return `${season}:${week}:${team.team}:${player}`;
}

export function attachAcquisitions(analytics, sources, payload, espnPayload) {
  if (payload.version !== 1 || payload.method !== "latest-franchise-acquisition" || !Array.isArray(payload.rows) ||
      payload.migration?.from !== "espn" || payload.migration.draft !== espnPayload?.migration?.draft ||
      !Array.isArray(espnPayload?.migration?.rows)) {
    throw new Error("Unsupported acquisition dataset");
  }
  const teams = new Map();
  const franchises = new Map();
  for (const source of sources) {
    if (source.platform !== "sleeper") continue;
    for (const mapping of source.crosswalk) {
      teams.set(`${mapping.season}:${mapping.roster_id}`, mapping.team.trim());
      franchises.set(`${mapping.season}:${mapping.roster_id}`,
        mapping.inheriting_owner?.trim() || mapping.owner.trim());
    }
  }
  const evidence = new Map();
  const inherited = new Map(espnPayload.migration.rows.map((row) => [row.player, row]));
  for (const row of payload.rows) {
    const team = teams.get(`${row.season}:${row.roster}`);
    if (!team || !Object.hasOwn(SOURCE_LABELS, row.source) || !Object.hasOwn(SOURCE_REASONS, row.reason) ||
        typeof row.points !== "number" || !Number.isFinite(row.points) ||
        !Number.isInteger(row.week) || row.week < 1 ||
        (row.source !== "unknown" && (!["verified", "migration"].includes(row.reason) ||
          !Number.isSafeInteger(row.acquiredAt) || !row.event ||
          !Number.isInteger(row.acquiredSeason) || row.acquiredSeason > row.season))) {
      throw new Error(`Invalid acquisition evidence in ${row.season} week ${row.week}`);
    }
    if (row.reason === "migration") {
      const original = inherited.get(row.player);
      if (row.originPlatform !== "espn" || !original || original.source === "unknown" ||
          original.source !== row.source || original.espnPlayer !== row.espnPlayer ||
          original.franchise !== franchises.get(`${row.season}:${row.roster}`) ||
          original.event !== row.event || original.acquiredAt !== row.acquiredAt ||
          original.acquiredSeason !== row.acquiredSeason ||
          !Number.isSafeInteger(row.acquiredBefore) || row.acquiredBefore < row.acquiredAt ||
          row.acquiredBefore >= espnPayload.migration.at ||
          row.acquiredBefore > original.acquiredBefore || row.identityMatch !== original.match) {
        throw new Error(`Invalid or stale ESPN migration evidence: ${row.player}`);
      }
    } else if (row.originPlatform === "espn") {
      throw new Error(`Missing ESPN migration reason: ${row.player}`);
    }
    const key = `${row.season}:${row.week}:${team}:${row.player}`;
    if (evidence.has(key)) throw new Error(`Duplicate acquisition evidence: ${key}`);
    evidence.set(key, row);
  }
  const rows = analytics.starters.map((start) => {
    const key = startKey(start.season, start.week, start.team, start.player);
    const row = evidence.get(key);
    if (!row || Math.round(row.points * 100) !== start.points) {
      throw new Error(`Missing or stale acquisition evidence: ${key}`);
    }
    evidence.delete(key);
    const window = payload.windows?.[`${start.season}:${start.week}`];
    if (!Array.isArray(window) || window.length !== 2 ||
        !window.every(Number.isSafeInteger) || window[0] > window[1] ||
        (row.source !== "unknown" && row.acquiredAt > window[1])) {
      throw new Error(`Invalid acquisition kickoff window: ${key}`);
    }
    return { ...start, source: row.source, reason: row.reason, acquiredAt: row.acquiredAt,
      acquiredSeason: row.acquiredSeason, event: row.event, kind: row.kind,
      originPlatform: row.originPlatform, acquiredBefore: row.acquiredBefore,
      espnPlayer: row.espnPlayer, identityMatch: row.identityMatch };
  });
  if (evidence.size) throw new Error("Acquisition data contains starts absent from historical details");
  return rows;
}

export function attachESPN(analytics, payload) {
  if (payload.version !== 1 || payload.platform !== "espn" || payload.method !== "latest-franchise-acquisition" ||
      payload.provenanceStart !== 2016 || payload.missingTradePolicy !== "ignore" ||
      !Array.isArray(payload.historyAudit) || payload.historyAudit.length !== 2 ||
      ![2016, 2017].every((season) => payload.historyAudit.some((audit) => audit.season === season)) ||
      !Array.isArray(payload.rows) || !Array.isArray(payload.scores) || !Array.isArray(payload.audit)) {
    throw new Error("Unsupported ESPN acquisition dataset");
  }
  const seasons = new Set();
  for (const audit of payload.audit) {
    const coverage = analytics.coverage.find((entry) => entry.platform === "espn" && entry.season === audit.season);
    if (!coverage || audit.season < 2018 || audit.season > 2021 || seasons.has(audit.season) ||
        audit.regularWeeks !== coverage.regularWeeks) throw new Error("Invalid ESPN acquisition coverage");
    seasons.add(audit.season);
  }
  if (seasons.size !== analytics.coverage.filter((entry) => entry.platform === "espn" &&
      entry.season >= 2018 && entry.season <= 2021).length) throw new Error("Missing ESPN acquisition seasons");
  const expected = new Map();
  for (const game of analytics.games.filter((entry) => entry.platform === "espn" && seasons.has(entry.season))) {
    for (const [team, points] of [[game.home, game.homeScore], [game.away, game.awayScore]]) {
      expected.set(`${game.season}:${game.week}:${team.team}`, { team, points });
    }
  }
  const scores = new Map();
  for (const score of payload.scores) {
    const key = `${score.season}:${score.week}:${score.team}`;
    if (!expected.has(key) || scores.has(key) || typeof score.points !== "number" ||
        !Number.isFinite(score.points) || Math.round(score.points * 100) !== expected.get(key).points ||
        !Number.isInteger(score.starts) || score.starts < 1 || typeof score.starterPoints !== "number" ||
        !Number.isFinite(score.starterPoints)) {
      throw new Error(`Missing, duplicate or stale ESPN team score: ${key}`);
    }
    scores.set(key, { count: 0, points: 0, starts: score.starts, expectedPoints: Math.round(score.starterPoints * 100) });
  }
  if (scores.size !== expected.size) throw new Error("Missing ESPN weekly team scores");
  const seen = new Set();
  const rows = payload.rows.map((row) => {
    const teamKey = `${row.season}:${row.week}:${row.team}`;
    const key = `${teamKey}:${row.player}`;
    const window = payload.windows?.[`${row.season}:${row.week}`];
    const known = row.source !== "unknown";
    if (!scores.has(teamKey) || seen.has(key) || !/^-?\d+$/.test(row.player) || !row.name || !row.position ||
        !Object.hasOwn(SOURCE_LABELS, row.source) || !Object.hasOwn(SOURCE_REASONS, row.reason) ||
        !Number.isInteger(row.week) || typeof row.points !== "number" || !Number.isFinite(row.points) ||
        (row.reportedZero && row.points !== 0) ||
        (known && (!["verified", "interval"].includes(row.reason) || !row.event || !row.kind ||
          !Number.isSafeInteger(row.acquiredAt) || !Number.isSafeInteger(row.acquiredBefore) ||
          row.acquiredAt > row.acquiredBefore || !Number.isInteger(row.acquiredSeason) ||
          row.acquiredSeason < payload.provenanceStart || row.acquiredSeason > row.season))) {
      throw new Error(`Invalid or duplicate ESPN acquisition evidence: ${key}`);
    }
    if (!Array.isArray(window) || window.length !== 2 || !window.every(Number.isSafeInteger) ||
        window[0] > window[1] || (known && row.acquiredAt > window[1])) {
      throw new Error(`Invalid ESPN acquisition kickoff window: ${key}`);
    }
    seen.add(key);
    const score = scores.get(teamKey);
    score.count++;
    score.points += Math.round(row.points * 100);
    return { ...row, team: expected.get(teamKey).team, player: `espn:${row.player}`,
      platform: "espn", points: Math.round(row.points * 100), stage: "regular" };
  });
  if ([...scores.values()].some((score) => score.count !== score.starts || score.points !== score.expectedPoints)) {
    throw new Error("Missing or stale ESPN weekly starters");
  }
  return rows;
}

export function acquisitionSummary(rows, games, history, mode = "franchise", season = "", scope = "regular", era = "all") {
  const covered = new Set(rows.filter((row) => era === "all" || row.platform === era)
    .map((row) => `${row.platform}:${row.season}`));
  const eligible = rows.filter((row) => covered.has(`${row.platform}:${row.season}`) &&
    (!season || row.season === Number(season)) &&
    (scope === "all" ? row.stage !== "bye" : row.stage === scope));
  const selectedGames = games.filter((game) => covered.has(`${game.platform}:${game.season}`) &&
    (!season || game.season === Number(season)) && (scope === "all" || game.stage === scope) &&
    (game.platform !== "espn" || game.stage === "regular"));
  const groups = new Map();
  for (const team of history.filter((team) => covered.has(`${team.platform}:${team.season}`) &&
      (!season || team.season === Number(season)) && (scope !== "playoff" || team.platform !== "espn"))) {
    const person = team[mode];
    if (!groups.has(person.id)) groups.set(person.id, { id: person.id, name: person.name,
      buckets: { draft: 0, trade: 0, freeAgency: 0, unknown: 0 }, points: 0, teamPoints: 0,
      standingPoints: scope === "regular" ? 0 : null, starts: 0, players: new Map(), seasons: new Set() });
    const group = groups.get(person.id);
    if (scope === "regular") group.standingPoints += Math.round(team.pointsFor * 100);
    group.seasons.add(team.season);
  }
  for (const row of eligible) {
    const group = groups.get(row.team[mode].id);
    if (!group) throw new Error("Unknown scoring franchise in acquisition summary");
    group.buckets[row.source] += row.points;
    group.points += row.points;
    group.starts++;
    const id = `${row.platform}:${row.player}:${row.source}`;
    if (!group.players.has(id)) group.players.set(id, { player: row.player, name: row.name, position: row.position,
      platform: row.platform, source: row.source, points: 0, starts: 0, evidence: [] });
    const player = group.players.get(id);
    player.points += row.points;
    player.starts++;
    player.evidence.push(row);
  }
  for (const game of selectedGames) {
    for (const [team, points] of [[game.home, game.homeScore], [game.away, game.awayScore]]) {
      const group = groups.get(team[mode].id);
      if (!group) throw new Error("Unknown game franchise in acquisition summary");
      group.teamPoints += points;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group, adjustment: group.teamPoints - group.points,
    coverage: group.points > 0 ? (group.points - group.buckets.unknown) / group.points : null,
    shares: Object.fromEntries(Object.entries(group.buckets).map(([source, points]) =>
      [source, group.points !== 0 ? points / group.points : null])),
    players: [...group.players.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name) ||
      a.source.localeCompare(b.source)),
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}
