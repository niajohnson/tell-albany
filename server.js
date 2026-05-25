const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 4173;
const PUBLIC_DIR = path.join(__dirname, "public");

const ASSEMBLY_EMAIL_URL = "https://nyassembly.gov/mem/email/";
const BILL_URL = "https://nyassembly.gov/leg/?Actions=Y&Memo=Y&Summary=Y&bn=A01466&default_fld=&leg_video=&term=2025";
const HEALTH_COMMITTEE_URL = "https://www.nyassembly.gov/comm/?id=19&sec=mem";
const ASSEMBLY_LEADERSHIP_URL = "https://www.assembly.ny.gov/mem/leadership/";
const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const ADDRESS_SUGGEST_URL = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest";
const NY_SEARCH_EXTENT = "-79.7624,40.4774,-71.7517,45.0153";
const NY_REGIONAL_SEARCH_EXTENTS = [
  "-74.2591,40.4774,-73.7004,40.9176",
  "-73.8000,40.5500,-71.7517,41.2500",
  "-74.4000,40.9000,-73.4000,42.3000",
  "-74.4000,42.4000,-72.9000,43.3000",
  "-77.8000,42.0000,-74.8000,44.0000",
  "-79.7624,42.0000,-77.0000,43.4000",
  "-75.7000,43.0000,-73.2000,45.0153",
];
const MAX_SUGGESTION_CANDIDATES = 15;
const MAX_VERIFIED_SUGGESTIONS = 6;
const RATE_LIMITS = {
  lookup: { limit: 30, windowMs: 60 * 1000 },
  suggest: { limit: 120, windowMs: 60 * 1000 },
};

let contactsCache;
let billCache;
let healthCommitteeCache;
let leadershipCache;
const phoneCache = new Map();
const suggestionCache = new Map();
const rateLimitBuckets = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendRateLimit(res, retryAfterSeconds) {
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": String(retryAfterSeconds),
  });
  res.end(
    JSON.stringify({
      error: "Too many requests. Please wait a moment and try again.",
      code: "rate_limited",
      retryAfterSeconds,
    })
  );
}

function clientKey(req, action) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
  return `${action}:${ip}`;
}

function checkRateLimit(req, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true };

  const now = Date.now();
  const key = clientKey(req, action);
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true };
  }

  if (bucket.count >= config.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { allowed: true };
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now >= bucket.resetAt) rateLimitBuckets.delete(key);
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value = "") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(assemblymember|assemblyman|assemblywoman|senator|the|hon\.?|jr\.?|sr\.?|ii|iii|iv)\b/gi, "")
    .replace(/[^a-z\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function nameKey(value) {
  const parts = normalizeName(value).split(" ").filter(Boolean);
  if (parts.length === 0) return "";
  return `${parts[0][0] || ""}:${parts.at(-1)}`;
}

function parseAssemblyContacts(html) {
  const itemPattern = /<li>\s*<a[^>]+href="(\/mem\/[^"]+)">\s*([^<]+?)<\/a>\s*<div class="email2">(\d{1,3})(?:st|nd|rd|th)\s+District<\/div>\s*<a href="mailto:([^"'>?\s]+)">/gi;
  const listContacts = [];
  let itemMatch;

  while ((itemMatch = itemPattern.exec(html))) {
    listContacts.push({
      district: String(Number(itemMatch[3])),
      name: stripTags(itemMatch[2]),
      email: decodeURIComponent(itemMatch[4]),
      profileUrl: new URL(itemMatch[1], ASSEMBLY_EMAIL_URL).toString(),
    });
  }
  if (listContacts.length > 0) return listContacts;

  const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
  const contacts = [];
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html))) {
    const row = rowMatch[0];
    const emailMatch = row.match(/mailto:([^"'>?\s]+)/i);
    if (!emailMatch) continue;

    const cells = [...row.matchAll(/<td[\s\S]*?<\/td>/gi)].map((cell) => stripTags(cell[0]));
    const joined = stripTags(row);
    const districtMatch = joined.match(/\b(?:District|AD)?\s*(\d{1,3})\b/i);
    const nameCell = cells.find((cell) => /[A-Za-z]/.test(cell) && !cell.includes("@")) || "";
    const name = nameCell
      .replace(/^Assembly(?:member|man|woman)\s+/i, "")
      .replace(/\s+\d{1,3}\s*$/, "")
      .trim();

    if (!name || !districtMatch) continue;
    contacts.push({
      district: String(Number(districtMatch[1])),
      name,
      email: decodeURIComponent(emailMatch[1]),
      profileUrl: "",
    });
  }

  if (contacts.length > 0) return contacts;

  const fallbackPattern = /Assembly(?:member|man|woman)?\s+([^<\n]+?)[\s\S]{0,220}?District\s*(\d{1,3})[\s\S]{0,220}?mailto:([^"'>?\s]+)/gi;
  let fallbackMatch;
  while ((fallbackMatch = fallbackPattern.exec(html))) {
    contacts.push({
      district: String(Number(fallbackMatch[2])),
      name: stripTags(fallbackMatch[1]),
      email: decodeURIComponent(fallbackMatch[3]),
      profileUrl: "",
    });
  }
  return contacts;
}

function parseHealthCommittee(html) {
  const text = stripTags(html);
  const section = text.match(/Chair\s+(.+?)\s+(?:News|Reports|Hearings|Assembly Home|$)/i)?.[1] || text;
  const entries = [];
  const memberPattern = /([A-Z][A-Za-z .'-]+?)\s+District\s+(\d{1,3})\s+([A-Za-z0-9._%+-]+@nyassembly\.gov)/g;
  let match;

  while ((match = memberPattern.exec(section))) {
    const name = match[1].replace(/\s+/g, " ").trim();
    if (!name || entries.some((entry) => nameKey(entry.name) === nameKey(name))) continue;
    entries.push({
      name,
      district: String(Number(match[2])),
      email: match[3],
      title: entries.length === 0 ? "Health Committee Chair" : "Health Committee member",
    });
  }

  return entries;
}

function parseAssemblyLeadership(html) {
  const text = stripTags(html);
  const titles = [
    "Speaker",
    "Majority Leader",
    "Chair, Ways and Means Committee",
    "Deputy Speaker",
    "Assistant Speaker",
    "Speaker Pro Tempore",
    "Chair, Committee on Standing Committees",
    "Assistant Speaker Pro Tempore",
    "Deputy Majority Leader",
    "Assistant Majority Leader",
    "Majority Whip",
    "Deputy Majority Whip",
    "Assistant Majority Whip",
    "Chair, Majority Conference",
    "Vice-Chair, Majority Conference",
    "Chair, Majority Steering",
    "Vice-Chair, Majority Steering",
    "Chair, Majority House Operations",
    "Minority Leader",
    "Minority Leader Pro Tempore",
    "Deputy Minority Leader",
    "Assistant Minority Leader",
    "Minority Whip",
    "Deputy Minority Whip",
    "Assistant Minority Whip",
  ];
  const titlePattern = [...titles]
    .sort((a, b) => b.length - a.length)
    .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const entryPattern = new RegExp(`(${titlePattern})\\s+([A-Z][A-Za-z .'-]+?)\\s+[^@]{0,900}?([A-Za-z0-9._%+-]+@nyassembly\\.gov)`, "g");
  const entries = [];
  let match;

  while ((match = entryPattern.exec(text))) {
    const name = match[2].replace(/\s+/g, " ").trim();
    if (!name || entries.some((entry) => nameKey(entry.name) === nameKey(name))) continue;
    entries.push({
      title: match[1],
      name,
      email: match[3],
    });
  }

  return entries;
}

function parsePhoneInfo(html) {
  const text = stripTags(html);
  const phonePattern = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g;
  const districtSection = text.match(/District Office\s+(.+?)(?:Albany Office|Assembly Home|$)/i)?.[1] || "";
  const albanySection = text.match(/Albany Office\s+(.+?)(?:[A-Za-z0-9._%+-]+@|Assembly Home|$)/i)?.[1] || "";

  const districtPhones = [...districtSection.matchAll(phonePattern)].map((match) => match[0]);
  const albanyPhones = [...albanySection.matchAll(phonePattern)].map((match) => match[0]);
  const allPhones = [...text.matchAll(phonePattern)].map((match) => match[0]);
  const districtPhone = districtPhones[0] || "";
  const albanyPhone = albanyPhones[0] || "";
  const phone = districtPhone || albanyPhone || allPhones[0] || "";

  return {
    phone,
    districtPhone,
    albanyPhone,
  };
}

async function getMemberPhoneInfo(member) {
  if (!member.profileUrl) return { phone: "", districtPhone: "", albanyPhone: "" };
  const contactUrl = new URL("contact/", member.profileUrl.endsWith("/") ? member.profileUrl : `${member.profileUrl}/`).toString();
  const cached = phoneCache.get(contactUrl);
  if (cached && Date.now() - cached.fetchedAt < 1000 * 60 * 60 * 12) return cached.info;

  const response = await fetch(contactUrl, {
    headers: { "user-agent": "NY Health Act constituent contact helper" },
  });
  if (!response.ok) return { phone: "", districtPhone: "", albanyPhone: "", contactUrl };

  const info = {
    ...parsePhoneInfo(await response.text()),
    contactUrl,
  };
  phoneCache.set(contactUrl, { fetchedAt: Date.now(), info });
  return info;
}

async function getAssemblyContacts() {
  if (contactsCache && Date.now() - contactsCache.fetchedAt < 1000 * 60 * 60 * 12) {
    return contactsCache.contacts;
  }

  const response = await fetch(ASSEMBLY_EMAIL_URL, {
    headers: { "user-agent": "NY Health Act constituent contact helper" },
  });
  if (!response.ok) throw new Error(`Assembly contact page returned ${response.status}`);

  const contacts = parseAssemblyContacts(await response.text());
  if (contacts.length < 100) {
    throw new Error("Could not parse enough Assembly contacts from the official page.");
  }

  contactsCache = { fetchedAt: Date.now(), contacts };
  return contacts;
}

function parseBillInfo(html) {
  const text = stripTags(html);
  const statusMatches = [...text.matchAll(/(\d{2}\/\d{2}\/\d{4}\s+referred to health)/gi)];
  const statusMatch = statusMatches.at(-1);
  const sponsorSection = text.match(/SPONSOR\s+(.+?)\s+COSPNSR/i);
  const coSponsorSection = text.match(/COSPNSR\s+(.+?)\s+MLTSPNSR/i);
  const multiSponsorSection = text.match(/MLTSPNSR\s+(.+?)\s+(?:Ren Art|Establishes|A01466 Actions)/i);
  const names = [sponsorSection?.[1], coSponsorSection?.[1], multiSponsorSection?.[1]]
    .filter(Boolean)
    .flatMap((section) =>
      section
        .replace(/\(MS\)/gi, "")
        .split(/,\s*|;| and /i)
        .map((part) => part.trim())
        .filter((part) => /^[A-Z][A-Za-z .'-]{2,}$/.test(part))
    );

  return {
    status: statusMatch?.[1] || "referred to Assembly Health Committee",
    supporters: [...new Set(names)],
    url: BILL_URL,
    checkedAt: new Date().toISOString(),
  };
}

async function getBillInfo() {
  if (billCache && Date.now() - billCache.fetchedAt < 1000 * 60 * 60 * 12) {
    return billCache.info;
  }

  const response = await fetch(BILL_URL, {
    headers: { "user-agent": "NY Health Act constituent contact helper" },
  });
  if (!response.ok) throw new Error(`Bill page returned ${response.status}`);

  const info = parseBillInfo(await response.text());
  billCache = { fetchedAt: Date.now(), info };
  return info;
}

async function getHealthCommittee() {
  if (healthCommitteeCache && Date.now() - healthCommitteeCache.fetchedAt < 1000 * 60 * 60 * 12) {
    return healthCommitteeCache.members;
  }

  const response = await fetch(HEALTH_COMMITTEE_URL, {
    headers: { "user-agent": "NY Health Act constituent contact helper" },
  });
  if (!response.ok) throw new Error(`Health Committee page returned ${response.status}`);

  const members = parseHealthCommittee(await response.text());
  if (members.length < 10) throw new Error("Could not parse enough Health Committee members.");

  healthCommitteeCache = { fetchedAt: Date.now(), members };
  return members;
}

async function getAssemblyLeadership() {
  if (leadershipCache && Date.now() - leadershipCache.fetchedAt < 1000 * 60 * 60 * 12) {
    return leadershipCache.members;
  }

  const response = await fetch(ASSEMBLY_LEADERSHIP_URL, {
    headers: { "user-agent": "NY Health Act constituent contact helper" },
  });
  if (!response.ok) throw new Error(`Assembly leadership page returned ${response.status}`);

  const members = parseAssemblyLeadership(await response.text());
  if (members.length < 5) throw new Error("Could not parse enough Assembly leadership members.");

  leadershipCache = { fetchedAt: Date.now(), members };
  return members;
}

function memberRoleInfo(member, healthCommittee, leadership) {
  const memberKey = nameKey(member.name);
  const healthRole = healthCommittee.find((entry) => nameKey(entry.name) === memberKey || entry.email.toLowerCase() === member.email.toLowerCase());
  const leadershipRole = leadership.find((entry) => nameKey(entry.name) === memberKey || entry.email.toLowerCase() === member.email.toLowerCase());
  const roles = [];

  if (leadershipRole) {
    roles.push({
      type: "leadership",
      label: "Assembly leadership",
      title: leadershipRole.title,
    });
  }

  if (healthRole) {
    roles.push({
      type: "health-committee",
      label: healthRole.title === "Health Committee Chair" ? "Health Committee chair" : "Health Committee",
      title: healthRole.title,
    });
  }

  return roles;
}

function roleFlags({ status, roles }) {
  return {
    isSupporter: status === "listed" || status === "likely-listed",
    isLeadership: roles.some((role) => role.type === "leadership"),
    isHealthCommittee: roles.some((role) => role.type === "health-committee"),
  };
}

function askTypeFor(context) {
  const { isSupporter, isLeadership, isHealthCommittee } = roleFlags(context);
  if (isLeadership && isHealthCommittee && isSupporter) return "leadership-health-supporter";
  if (isLeadership && isHealthCommittee) return "leadership-health";
  if (isLeadership && isSupporter) return "leadership-supporter";
  if (isLeadership) return "leadership";
  if (isHealthCommittee && isSupporter) return "health-supporter";
  if (isHealthCommittee) return "health";
  if (isSupporter) return "supporter";
  return "cosponsor";
}

function askCopy(askType) {
  const copies = {
    "leadership-health-supporter": {
      support: [
        "Thank you for supporting A1466 and for your leadership in the Assembly and on the Health Committee.",
        "I appreciate that you are listed in support of A1466 and that you hold leadership and Health Committee roles.",
        "I was glad to see your name listed in support of A1466, especially given your leadership and Health Committee roles.",
      ],
      email: [
        "Please use those roles to prioritize A1466 for committee movement, move it out of Health Committee, and advance it toward a floor vote this session.",
        "Please help move A1466 out of Health Committee and prioritize it for a floor vote this session.",
        "Please use your support and leadership to move A1466 through Health Committee and toward a floor vote.",
      ],
      call: "move A1466 out of Health Committee and prioritize it for a floor vote",
    },
    "leadership-health": {
      support: [
        "Because you hold leadership and Health Committee roles, you have a direct role in whether A1466 moves.",
        "Your leadership and Health Committee roles make your action especially important.",
        "As both an Assembly leader and a Health Committee member, you can help determine whether A1466 advances.",
      ],
      email: [
        "Please co-sponsor A1466, move it out of Health Committee, and prioritize it for a floor vote this session.",
        "Please publicly support A1466 and use your roles to move it out of Health Committee and toward a floor vote.",
        "Please sign on to A1466 and help move it through Health Committee and onto the Assembly floor.",
      ],
      call: "co-sponsor A1466, move it out of Health Committee, and prioritize it for a floor vote",
    },
    "leadership-supporter": {
      support: [
        "Thank you for supporting A1466 and for your leadership in the Assembly.",
        "I appreciate that you are listed in support of A1466 and that you hold an Assembly leadership role.",
        "I was glad to see your name listed in support of A1466, especially given your leadership role.",
      ],
      email: [
        "Please use your leadership role to prioritize A1466 for committee movement and a floor vote this session.",
        "Please turn that support into action by prioritizing A1466 for committee movement and a floor vote.",
        "Please help make A1466 a leadership priority for committee movement and a floor vote this session.",
      ],
      call: "prioritize A1466 for committee movement and a floor vote",
    },
    leadership: {
      support: [
        "Because you hold an Assembly leadership role, your action is especially important.",
        "As an Assembly leader, you can help determine whether A1466 moves this session.",
        "Your leadership role gives you a real opportunity to help advance A1466.",
      ],
      email: [
        "Please co-sponsor A1466 and prioritize it for committee movement and a floor vote this session.",
        "Please publicly support A1466 and use your leadership role to move it toward a floor vote.",
        "Please sign on to A1466 and help make it a priority for committee movement and a floor vote.",
      ],
      call: "co-sponsor A1466 and prioritize it for committee movement and a floor vote",
    },
    "health-supporter": {
      support: [
        "Thank you for supporting A1466 and serving on the Assembly Health Committee.",
        "I appreciate that you are listed in support of A1466 and that you serve on the Health Committee.",
        "I was glad to see your name listed in support of A1466, especially because you are on the Health Committee.",
      ],
      email: [
        "Please use that role to move A1466 out of the Health Committee this session.",
        "Please turn that support into action by moving A1466 out of Health Committee this session.",
        "Please help make sure A1466 moves out of Health Committee this session.",
      ],
      call: "move A1466 out of the Assembly Health Committee this session",
    },
    health: {
      support: [
        "Because you serve on the Assembly Health Committee, your action is especially important.",
        "As a Health Committee member, you have a direct role in whether A1466 advances.",
        "Your Health Committee role gives you a clear opportunity to help move A1466.",
      ],
      email: [
        "Please co-sponsor A1466 and help move it out of the Health Committee this session.",
        "Please publicly support A1466 and move it out of Health Committee this session.",
        "Please sign on to A1466 and help advance it out of the Assembly Health Committee.",
      ],
      call: "co-sponsor A1466 and move it out of the Assembly Health Committee this session",
    },
    supporter: {
      support: [
        "Thank you for being listed as a supporter.",
        "I appreciate that you are listed in support of A1466.",
        "I was glad to see your name listed in support of the bill.",
      ],
      email: [
        "Please actively push for A1466 to be placed on the Health Committee agenda before June 10.",
        "Please use your support to press for A1466 to be put on the Health Committee agenda before June 10.",
        "Please help make sure A1466 is placed on the Health Committee agenda before June 10.",
      ],
      call: "push for A1466 to be placed on the Health Committee agenda before June 10",
    },
    cosponsor: {
      support: [
        "I am asking you to support it.",
        "Please stand with New Yorkers who need universal health care.",
        "Please help move this bill forward.",
      ],
      email: [
        "Please co-sponsor A1466 and publicly support the bill.",
        "Please add your name as a co-sponsor of A1466.",
        "Please sign on as a co-sponsor and publicly support A1466.",
      ],
      call: "co-sponsor A1466 and publicly support the bill",
    },
  };
  return copies[askType] || copies.cosponsor;
}

function findLowerDistrict(geographies) {
  const entries = Object.entries(geographies || {});
  const lowerEntry = entries.find(([key]) => key.toLowerCase().includes("state legislative districts - lower"));
  const districts = lowerEntry?.[1];
  const district = Array.isArray(districts) ? districts[0] : undefined;
  const raw = district?.BASENAME || district?.SLDL || district?.NAME || "";
  const match = String(raw).match(/\d{1,3}/);
  return match ? String(Number(match[0])) : "";
}

async function lookupDistrict(address) {
  const params = new URLSearchParams({
    address,
    benchmark: "Public_AR_Current",
    vintage: "Current_Current",
    format: "json",
  });
  const response = await fetch(`${CENSUS_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`Census geocoder returned ${response.status}`);

  const data = await response.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return { error: "No address match found. Try including city, state, and ZIP." };

  const state = match.geographies?.States?.[0]?.STUSAB || match.geographies?.States?.[0]?.STATE;
  if (state && !String(state).toUpperCase().includes("NY") && state !== "36") {
    return { error: "That address does not appear to be in New York State." };
  }

  const district = findLowerDistrict(match.geographies);
  if (!district) return { error: "Found the address, but not the Assembly district." };

  return {
    district,
    matchedAddress: match.matchedAddress,
  };
}

function cityKeyFromAddress(address) {
  const parts = String(address)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const nyIndex = parts.findIndex((part) => part.toUpperCase() === "NY");
  if (nyIndex > 0) return parts[nyIndex - 1].toLowerCase();
  return parts.slice(-3, -2)[0]?.toLowerCase() || address.toLowerCase();
}

function diversifySuggestions(suggestions) {
  const sorted = [...suggestions].sort((a, b) => a.originalIndex - b.originalIndex);
  const seenCities = new Set();
  const diverse = [];

  for (const suggestion of sorted) {
    if (seenCities.has(suggestion.cityKey)) continue;
    seenCities.add(suggestion.cityKey);
    diverse.push(suggestion);
    if (diverse.length >= MAX_VERIFIED_SUGGESTIONS) return diverse;
  }

  for (const suggestion of sorted) {
    if (diverse.includes(suggestion)) continue;
    diverse.push(suggestion);
    if (diverse.length >= MAX_VERIFIED_SUGGESTIONS) break;
  }

  return diverse;
}

async function fetchArcGisSuggestions(text, searchExtent, maxSuggestions) {
  const params = new URLSearchParams({
    f: "json",
    text,
    countryCode: "USA",
    category: "Address",
    searchExtent,
    maxSuggestions: String(maxSuggestions),
  });
  const response = await fetch(`${ADDRESS_SUGGEST_URL}?${params.toString()}`, {
    headers: { "user-agent": "NY Health Act constituent contact helper" },
  });
  if (!response.ok) throw new Error(`Address suggestions returned ${response.status}`);
  const data = await response.json();
  return data.suggestions || [];
}

async function lookupAddressSuggestions(text) {
  if (text.length < 3) return [];
  const cacheKey = text.toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 1000 * 60 * 30) return cached.suggestions;

  const useRegionalSearch = text.length <= 4 || /^\d+\s*$/.test(text);
  const rawSuggestions = useRegionalSearch
    ? (
        await Promise.all(
          NY_REGIONAL_SEARCH_EXTENTS.map((extent) => fetchArcGisSuggestions(text, extent, 5))
        )
      ).flat()
    : await fetchArcGisSuggestions(text, NY_SEARCH_EXTENT, MAX_SUGGESTION_CANDIDATES);
  const uniqueSuggestionMap = new Map();
  for (const suggestion of rawSuggestions) {
    if (!uniqueSuggestionMap.has(suggestion.text)) uniqueSuggestionMap.set(suggestion.text, suggestion);
  }
  const candidates = [...uniqueSuggestionMap.values()]
    .filter((suggestion) => /,\s*NY\b/i.test(suggestion.text))
    .slice(0, useRegionalSearch ? 30 : MAX_SUGGESTION_CANDIDATES);

  const checked = await Promise.all(
    candidates.map(async (suggestion, originalIndex) => {
      const cleanText = suggestion.text.replace(/,\s*USA$/i, "");
      const districtResult = await lookupDistrict(cleanText);
      if (districtResult.error) return null;
      return {
        cityKey: cityKeyFromAddress(districtResult.matchedAddress || cleanText),
        originalText: cleanText,
        originalIndex,
        text: districtResult.matchedAddress || cleanText,
        district: districtResult.district,
        magicKey: suggestion.magicKey,
      };
    })
  );

  const verified = diversifySuggestions(checked.filter(Boolean)).map((suggestion) => ({
    text: suggestion.text,
    district: suggestion.district,
    magicKey: suggestion.magicKey,
  }));

  suggestionCache.set(cacheKey, { fetchedAt: Date.now(), suggestions: verified });
  return verified;
}

function supporterStatus(member, supporters) {
  const memberKey = nameKey(member.name);
  const supporterKeys = new Set(supporters.map(nameKey));
  if (supporterKeys.has(memberKey)) return "listed";

  const memberLast = memberKey.split(":")[1];
  const likely = supporters.find((supporter) => nameKey(supporter).endsWith(`:${memberLast}`));
  return likely ? "likely-listed" : "not-listed";
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function readableBillStatus(status) {
  const referredMatch = status.match(/(\d{2})\/(\d{2})\/(\d{4})\s+referred to health/i);
  if (!referredMatch) return "The Assembly bill page shows A1466 is still awaiting further action.";

  const [, month, day, year] = referredMatch;
  const date = new Date(`${year}-${month}-${day}T00:00:00`);
  const formattedDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);

  return `The Assembly currently lists A1466 as referred to the Health Committee as of ${formattedDate}.`;
}

function makeDraft({ member, district, matchedAddress, status, roles, bill, senderName }) {
  const askType = askTypeFor({ status, roles });
  const copy = askCopy(askType);
  const billStatus = readableBillStatus(bill.status);
  const supportLine = pick(copy.support);
  const askLine = pick(copy.email);
  const opening = pick([
    `I live in Assembly District ${district}, and I am writing about the New York Health Act (A1466).`,
    `I am a constituent in Assembly District ${district}, and I want to see the New York Health Act (A1466) move forward this session.`,
    `As someone in Assembly District ${district}, I am asking you to help advance the New York Health Act (A1466).`,
  ]);
  const why = pick([
    "New Yorkers should be able to get care without worrying that a job loss, premium increase, or medical bill will put treatment out of reach.",
    "Health care should not depend on where someone works, how much they earn, their age, disability, or immigration status.",
    "Too many people delay care because of cost, confusing coverage rules, or fear of medical debt. New York can do better.",
    "A universal health care program would make it easier for people to get the care they need and reduce the stress of navigating private insurance.",
  ]);
  const closing = pick([
    "Please let me know what steps you will take to help A1466 move forward.",
    "I would appreciate a reply letting me know where you stand and what you will do next.",
    "Please let me know how you plan to support movement on this bill.",
  ]);

  return [
    `Dear Assemblymember ${member.name},`,
    "",
    `${opening} ${supportLine}`,
    "",
    why,
    "",
    `${billStatus} ${askLine}`,
    "",
    closing,
    "",
    "Thank you,",
    senderName || "[Your name]",
    matchedAddress ? `[${matchedAddress}]` : "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

async function handleLookup(req, res, url) {
  const limit = checkRateLimit(req, "lookup");
  if (!limit.allowed) return sendRateLimit(res, limit.retryAfterSeconds);

  const address = url.searchParams.get("address")?.trim();
  const senderName = url.searchParams.get("name")?.trim();
  if (!address) return sendJson(res, 400, { error: "Enter a New York address." });

  const [districtResult, contacts, bill, healthCommittee, leadership] = await Promise.all([
    lookupDistrict(address),
    getAssemblyContacts(),
    getBillInfo(),
    getHealthCommittee(),
    getAssemblyLeadership(),
  ]);

  if (districtResult.error) return sendJson(res, 404, districtResult);

  const member = contacts.find((contact) => contact.district === districtResult.district);
  if (!member) {
    return sendJson(res, 404, {
      error: `Found Assembly District ${districtResult.district}, but could not match it to a member.`,
    });
  }

  const status = supporterStatus(member, bill.supporters);
  const roles = memberRoleInfo(member, healthCommittee, leadership);
  const askType = askTypeFor({ status, roles });
  const phoneInfo = await getMemberPhoneInfo(member);
  const subject = "Please advance the New York Health Act (A1466)";
  const body = makeDraft({
    member,
    district: districtResult.district,
    matchedAddress: districtResult.matchedAddress,
    status,
    roles,
    bill,
    senderName,
  });

  sendJson(res, 200, {
    district: districtResult.district,
    matchedAddress: districtResult.matchedAddress,
    senderName,
    member: {
      ...member,
      ...phoneInfo,
    },
    bill,
    supporterStatus: status,
    roles,
    askType,
    subject,
    body,
    mailto: `mailto:${encodeURIComponent(member.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    sources: {
      assemblyContacts: ASSEMBLY_EMAIL_URL,
      bill: BILL_URL,
      healthCommittee: HEALTH_COMMITTEE_URL,
      leadership: ASSEMBLY_LEADERSHIP_URL,
      district: "https://geocoding.geo.census.gov/",
    },
  });
}

async function handleSuggest(req, res, url) {
  const limit = checkRateLimit(req, "suggest");
  if (!limit.allowed) return sendRateLimit(res, limit.retryAfterSeconds);

  const text = url.searchParams.get("text")?.trim();
  if (!text) return sendJson(res, 200, { suggestions: [] });

  const suggestions = await lookupAddressSuggestions(text);
  sendJson(res, 200, { suggestions });
}

async function serveStatic(req, res, url) {
  let filePath = path.normalize(decodeURIComponent(url.pathname));
  if (filePath === "/") filePath = "/index.html";
  if (filePath.includes("..")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const absolutePath = path.join(PUBLIC_DIR, filePath);
  try {
    const file = await fs.readFile(absolutePath);
    const ext = path.extname(absolutePath);
    res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/api/suggest") return await handleSuggest(req, res, url);
    if (url.pathname === "/api/lookup") return await handleLookup(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 503, {
      error: "One of the official data sources is temporarily unavailable. Please try again in a minute.",
      code: "source_unavailable",
      detail: error.message || "Something went wrong.",
    });
  }
});

setInterval(cleanupRateLimits, 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`NY Health Act helper running at http://${HOST}:${PORT}`);
});
