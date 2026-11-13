export const TRADE_BANDS = [
  { grade: "A-", minimum: 10000 },
  { grade: "B", minimum: -9999 },
  { grade: "C", minimum: -24999 },
  { grade: "D", minimum: -49999 },
  { grade: "F", minimum: -Infinity },
];

export function gradeTradeMargin(margin) {
  if (!Number.isSafeInteger(margin)) throw new Error("Trade margin must be integer hundredths");
  return TRADE_BANDS.find((band) => margin >= band.minimum).grade;
}

const eventKey = (platform, season, event, franchise, player) =>
  `${platform}:${season}:${event}:${franchise}:${player}`;
const tradeKey = (platform, season, event) => `${platform}:${season}:${event}`;
const pickKey = (asset) => `${asset.season}:${asset.round}:${asset.originalRoster}`;

export function buildTradeGrades(history, sources, acquisitions, sleeper, espn) {
  if (!Array.isArray(sleeper.trades) || !Array.isArray(sleeper.rookieDrafts) ||
      !Array.isArray(espn.trades) || !espn.tradeTeams || !sleeper.tradePlayers || !espn.tradePlayers) {
    throw new Error("Regenerate acquisition exports with trade assets before grading");
  }
  const teams = new Map();
  for (const source of sources) {
    for (const mapping of source.crosswalk) {
      const roster = source.platform === "sleeper" ? Number(mapping.roster_id) :
        Number(Object.entries(espn.tradeTeams[mapping.season] ?? {})
          .find(([, name]) => name === mapping.team.trim())?.[0]);
      const team = history.find((entry) => entry.platform === source.platform &&
        entry.season === Number(mapping.season) && entry.team === mapping.team.trim());
      if (!team || !Number.isInteger(roster)) throw new Error("Missing trade franchise mapping");
      teams.set(`${source.platform}:${mapping.season}:${roster}`, team);
    }
  }
  const getTeam = (platform, season, roster) => {
    const team = teams.get(`${platform}:${season}:${roster}`);
    if (!team) throw new Error(`Unknown trade roster: ${platform}:${season}:${roster}`);
    return team;
  };
  const returns = new Map();
  for (const row of acquisitions) {
    if (row.stage !== "regular" || row.source === "unknown") continue;
    const origin = row.originPlatform ?? row.platform;
    const player = origin === "espn" ? (row.espnPlayer ?? row.player.replace(/^espn:/, "")) : row.player;
    const key = eventKey(origin, row.acquiredSeason, row.event, row.team.franchise.id, player);
    returns.set(key, (returns.get(key) ?? 0) + row.points);
  }
  const earned = (platform, season, event, roster, player) =>
    returns.get(eventKey(platform, season, event, getTeam(platform, season, roster).franchise.id, player)) ?? 0;
  const drafts = new Map();
  const samples = new Map();
  const lastSeason = Math.max(...history.map((row) => row.season));
  for (const draft of sleeper.rookieDrafts) {
    if (!Number.isSafeInteger(draft.at) || !Array.isArray(draft.picks)) throw new Error("Invalid rookie draft");
    for (const pick of draft.picks) {
      const key = pickKey({ ...pick, season: draft.season });
      if (drafts.has(key) || !Number.isInteger(pick.round) || pick.round < 1) {
        throw new Error(`Duplicate or invalid original rookie pick: ${key}`);
      }
      const points = earned("sleeper", draft.season, draft.id, pick.roster, pick.player);
      drafts.set(key, { ...pick, draft, points });
      if (!samples.has(pick.round)) samples.set(pick.round, []);
      samples.get(pick.round).push(points);
    }
  }
  const averages = [...samples].sort(([a], [b]) => a - b).map(([round, values]) =>
    ({ round, points: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      count: values.length }));
  const records = [];
  const ids = new Set();
  for (const [platform, payload] of [["espn", espn], ["sleeper", sleeper]]) {
    for (const trade of payload.trades) {
      const key = tradeKey(platform, trade.season, trade.id);
      if (ids.has(key) || !Number.isSafeInteger(trade.at) || !Array.isArray(trade.assets) ||
          !Array.isArray(trade.participants) || !Array.isArray(trade.issues)) {
        throw new Error(`Invalid or duplicate trade: ${key}`);
      }
      ids.add(key);
      for (const roster of trade.participants) getTeam(platform, trade.season, roster);
      const assets = new Set();
      for (const asset of trade.assets) {
        if (!["player", "pick"].includes(asset.type) || asset.from === asset.to ||
            !trade.participants.includes(asset.from) || !trade.participants.includes(asset.to) ||
            (asset.type === "player" && (!asset.player || !payload.tradePlayers[asset.player])) ||
            (asset.type === "pick" && (!Number.isInteger(asset.season) ||
              !Number.isInteger(asset.round) || asset.round < 1 || !Number.isInteger(asset.originalRoster)))) {
          throw new Error(`Invalid trade asset: ${key}`);
        }
        const assetKey = asset.type === "player" ? `player:${asset.player}` : `pick:${pickKey(asset)}`;
        if (assets.has(assetKey)) throw new Error(`Duplicate trade asset: ${key}:${assetKey}`);
        assets.add(assetKey);
      }
      records.push({ ...trade, platform, key, names: payload.tradePlayers });
    }
  }
  const reports = records.map((trade) => {
    const issues = [...trade.issues];
    if (trade.platform === "espn" && trade.season < 2018) issues.push("Starter scores before 2018 are unavailable");
    if (trade.participants.length < 2 || !trade.assets.length) issues.push("Incomplete trade assets");
    const sides = trade.participants.map((roster) => {
      const team = getTeam(trade.platform, trade.season, roster);
      const assets = trade.assets.filter((asset) => asset.to === roster).map((asset) => {
        if (asset.type === "player") {
          return { ...asset, name: trade.names[asset.player],
            points: earned(trade.platform, trade.season, trade.id, roster, asset.player),
            estimated: false, note: "Starter points while held after this trade" };
        }
        const label = `${asset.season} round ${asset.round} (${getTeam(trade.platform, trade.season, asset.originalRoster).franchise.name})`;
        const onward = records.filter((later) => later.platform === trade.platform && later.at >= trade.at &&
          later.key !== trade.key && later.assets.some((move) =>
            move.type === "pick" && pickKey(move) === pickKey(asset) && move.from === roster));
        if (onward.some((later) => later.at === trade.at)) issues.push(`Ambiguous pick transfer: ${label}`);
        const selection = drafts.get(pickKey(asset));
        if (onward.some((later) => !selection || later.at <= selection.draft.at)) {
          return { ...asset, name: label, points: 0, estimated: false,
            note: "Traded away before selection; no replacement-asset credit" };
        }
        if (selection) {
          if (selection.draft.at < trade.at || selection.roster !== roster) {
            issues.push(`Unresolved pick ownership: ${label}`);
            return { ...asset, name: label, points: null, estimated: false,
              note: "Selection ownership could not be reconciled; return unavailable" };
          }
          const name = acquisitions.find((row) => row.platform === "sleeper" && row.player === selection.player)?.name ??
            sleeper.tradePlayers[selection.player] ?? selection.player;
          return { ...asset, name: `${label} selected ${name}`, points: selection.points,
            estimated: false, note: "Selected player's starter points until dropped or traded" };
        }
        const average = averages.find((entry) => entry.round === asset.round);
        if (asset.season <= lastSeason || !average || trade.platform !== "sleeper") {
          issues.push(`No resolved rookie pick or round estimate: ${label}`);
          return { ...asset, name: label, points: null, estimated: false,
            note: "Historical selection or round estimate unavailable" };
        }
        return { ...asset, name: label, points: average.points, estimated: true,
          note: `Unmade pick: mean return of ${average.count} completed round-${asset.round} selections` };
      });
      return { roster, team, assets, points: assets.reduce((sum, asset) => sum + (asset.points ?? 0), 0),
        estimated: assets.some((asset) => asset.estimated) };
    });
    for (const side of sides) {
      const others = sides.filter((other) => other !== side);
      side.opponentPoints = others.length ?
        Math.round(others.reduce((sum, other) => sum + other.points, 0) / others.length) : 0;
      side.margin = side.points - side.opponentPoints;
      side.grade = issues.length ? null : gradeTradeMargin(side.margin);
    }
    return { ...trade, names: undefined, sides, issues: [...new Set(issues)],
      estimated: sides.some((side) => side.estimated) };
  }).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  const byKey = new Map(reports.map((report) => [report.key, report]));
  for (const row of acquisitions.filter((entry) => entry.source === "trade")) {
    const platform = row.originPlatform ?? row.platform;
    const report = byKey.get(tradeKey(platform, row.acquiredSeason, row.event));
    if (!report || report.issues.length) continue;
    const player = platform === "espn" ? (row.espnPlayer ?? row.player.replace(/^espn:/, "")) : row.player;
    if (!report.sides.some((side) => side.team.franchise.id === row.team.franchise.id &&
        side.assets.some((asset) => asset.type === "player" && asset.player === player))) {
      throw new Error(`Stale player/franchise trade evidence: ${report.key}:${player}`);
    }
  }
  return { reports, byKey, averages, lastSeason };
}

export function acquisitionGrade(row, grades) {
  if (row.source === "draft") return { grade: "A", reason: "Draft acquisition" };
  if (row.source === "freeAgency") return { grade: "A+", reason: "Free-agent or waiver acquisition" };
  if (row.source !== "trade") return { grade: null, reason: "Acquisition source is unknown" };
  const platform = row.originPlatform ?? row.platform;
  const report = grades?.byKey.get(tradeKey(platform, row.acquiredSeason, row.event));
  const side = report?.sides.find((entry) => entry.team.franchise.id === row.team.franchise.id);
  return { grade: side?.grade ?? null, report, side,
    reason: !report ? "Complete historical trade details are unavailable" :
      !side ? "Receiving franchise is absent from the historical trade" : report.issues.join("; ") };
}
