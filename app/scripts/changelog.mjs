// CHANGELOG.md between releases: every change a user notices adds its line under
// "## [Unreleased]" as it lands; `npm run release` turns that section into the version and
// publishes it as the release notes (scripts/release.mjs). A release with nothing under
// [Unreleased] stops before the build. Copied from Quack's scripts/changelog.mjs (10/11/26),
// where 14 versions went out with no notes because nothing asked for them.

const HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const LINK = /^\[([^\]]+)\]: \S+\s*$/;

/** The file as lines, with each "## [x]" section's range; any other "## " heading ends a section */
export function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].startsWith("## ") || LINK.test(lines[i])) && open) {
      open.end = i;
      open = null;
    }
    const m = HEADING.exec(lines[i]);
    if (m) {
      open = { name: m[1], date: m[2], start: i, end: lines.length };
      sections.push(open);
    }
  }
  return { lines, sections };
}

function body(lines, s) {
  const out = lines.slice(s.start + 1, s.end);
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

const hasEntries = (lines) => lines.some((l) => /^\s*- \S/.test(l));
const isVersion = (s) => /^\d+\.\d+\.\d+$/.test(s.name);

/** A version's section without its heading: the GitHub release notes */
export function releaseNotes(text, version) {
  const { lines, sections } = parse(text);
  const s = sections.find((x) => x.name === version);
  if (!s) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return body(lines, s).join("\n") + "\n";
}

/**
 * [Unreleased] becomes `version` (dated `date`) under an empty [Unreleased], with the compare
 * links of `repo` ("owner/name"). When the newest section already is `version` (stamped, then
 * the release failed) new entries join it, and with none the text comes back unchanged.
 */
export function stampRelease(text, version, date, repo) {
  const { lines, sections } = parse(text);
  const unreleased = sections.find((s) => s.name === "Unreleased");
  if (!unreleased) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const added = body(lines, unreleased);
  const newest = sections.find(isVersion);
  if (!hasEntries(added)) {
    if (newest && newest.name === version) return lines.join("\n");
    throw new Error(`CHANGELOG.md has nothing under "## [Unreleased]": write what ${version} changes for its users there (Added / Changed / Fixed), commit it, then release`);
  }
  let out;
  let previous;
  if (newest && newest.name === version) {
    out = [
      ...lines.slice(0, unreleased.start + 1), "",
      ...lines.slice(unreleased.end, newest.start + 1), "", ...mergeGroups(body(lines, newest), added), "",
      ...lines.slice(newest.end),
    ];
    previous = sections.filter(isVersion)[1]?.name;
  } else {
    out = [...lines.slice(0, unreleased.start + 1), "", `## [${version}] - ${date}`, "", ...added, "", ...lines.slice(unreleased.end)];
    previous = newest?.name;
  }
  return relink(out, version, previous, repo);
}

function mergeGroups(a, b) {
  const order = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
  const groups = new Map();
  for (const part of [a, b]) {
    let kind = "Changed";
    for (const l of part) {
      const h = /^### (.+?)\s*$/.exec(l);
      if (h) { kind = h[1]; continue; }
      if (l.trim() === "") continue;
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(l);
    }
  }
  const kinds = [...groups.keys()].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
  return kinds.flatMap((k, i) => [...(i ? [""] : []), `### ${k}`, ...groups.get(k)]);
}

function relink(lines, version, previous, repo) {
  const base = `https://github.com/${repo}`;
  const kept = lines.filter((l) => {
    const m = LINK.exec(l);
    return !(m && (m[1] === "Unreleased" || m[1] === version));
  });
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const first = kept.findIndex((l) => LINK.test(l));
  const mine = [
    `[Unreleased]: ${base}/compare/v${version}...HEAD`,
    previous ? `[${version}]: ${base}/compare/v${previous}...v${version}` : `[${version}]: ${base}/releases/tag/v${version}`,
  ];
  if (first < 0) kept.push("", ...mine);
  else kept.splice(first, 0, ...mine);
  return kept.join("\n") + "\n";
}
