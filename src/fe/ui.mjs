export const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
export const number = (value, digits = 0) => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: digits, minimumFractionDigits: digits,
}).format(value);
export const percent = (value) => `${number(value * 100, 1)}%`;
export const record = (row) => `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""}`;
export const ordinal = (value) => value === null ? "—" : `${value}${value % 100 >= 11 && value % 100 <= 13 ? "th" :
  ({ 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th")}`;
export function sectionHeading(eyebrow, title, description = "") {
  return `<div class="section-heading"><span class="eyebrow accent">${escapeHTML(eyebrow)}</span>
    <h2 id="view-title">${escapeHTML(title)}</h2>${description ? `<p>${escapeHTML(description)}</p>` : ""}</div>`;
}
