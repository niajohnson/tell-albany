const form = document.querySelector("#lookup-form");
const statusBox = document.querySelector("#status");
const result = document.querySelector("#result");
const lookupButton = document.querySelector("#lookup-button");
const addressInput = document.querySelector("#address");
const suggestionsBox = document.querySelector("#address-suggestions");
const repName = document.querySelector("#rep-name");
const matchedAddress = document.querySelector("#matched-address");
const districtMeta = document.querySelector("#district-meta");
const emailMeta = document.querySelector("#email-meta");
const phoneMeta = document.querySelector("#phone-meta");
const supportBadge = document.querySelector("#support-badge");
const roleBadges = document.querySelector("#role-badges");
const supportChecked = document.querySelector("#support-checked");
const campaignWebsiteRow = document.querySelector("#campaign-website-row");
const campaignWebsite = document.querySelector("#campaign-website");
const callLine = document.querySelector("#call-line");
const callScript = document.querySelector("#call-script");
const callButton = document.querySelector("#call-button");
const subjectInput = document.querySelector("#subject");
const draftInput = document.querySelector("#draft");
const mailtoButton = document.querySelector("#mailto-button");
const gmailButton = document.querySelector("#gmail-button");
const outlookButton = document.querySelector("#outlook-button");
const yahooButton = document.querySelector("#yahoo-button");
const regenerateButton = document.querySelector("#regenerate-button");
const copyButton = document.querySelector("#copy-button");

let currentEmail = "";
let currentPhone = "";
let suggestions = [];
let selectedSuggestionIndex = -1;
let suggestionAbortController;
let suggestionTimer;

function setStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.dataset.type = type;
}

function trackMetric(event) {
  const body = JSON.stringify({ event });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/metric-event", new Blob([body], { type: "application/json" }));
    return;
  }

  fetch("/api/metric-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function rebuildMailto() {
  const to = encodeURIComponent(currentEmail);
  const subject = encodeURIComponent(subjectInput.value);
  const body = encodeURIComponent(draftInput.value);

  mailtoButton.href = `mailto:${to}?subject=${subject}&body=${body}`;
  gmailButton.href = `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}`;
  outlookButton.href = `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${subject}&body=${body}`;
  yahooButton.href = `https://compose.mail.yahoo.com/?to=${to}&subject=${subject}&body=${body}`;
}

function renderRoleBadges(roles = []) {
  roleBadges.innerHTML = "";
  for (const role of roles) {
    const badge = document.createElement("span");
    badge.className = "role-badge";
    badge.dataset.role = role.type;
    const visibleLabel = role.type === "leadership"
      ? "Leadership"
      : role.title === "Health Committee Chair"
        ? "Health Chair"
        : "Health Committee";
    const fullLabel = role.title ? `${role.label}: ${role.title}` : role.label;
    badge.textContent = visibleLabel;
    badge.title = fullLabel;
    badge.setAttribute("aria-label", fullLabel);
    roleBadges.append(badge);
  }
}

function renderElectionBadge(election) {
  document.querySelector(".election-badge")?.remove();
  campaignWebsiteRow.hidden = true;
  campaignWebsite.removeAttribute("href");
  campaignWebsite.textContent = "";

  if (election?.status !== "running") return;

  const badge = document.createElement("span");
  badge.className = "election-badge";
  badge.textContent = "Running in 2026";
  badge.title = election.sourceName ? `Matched from ${election.sourceName}` : "Matched from NYSBOE candidate filing data";
  badge.setAttribute("aria-label", badge.title);
  roleBadges.after(badge);

  if (election.website) {
    campaignWebsiteRow.hidden = false;
    campaignWebsite.href = election.website;
    campaignWebsite.textContent = election.website.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }
}

function phoneHref(phone) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

function formatCheckedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function friendlyError(data, fallback) {
  if (data?.code === "rate_limited") {
    return `Too many requests. Please wait ${data.retryAfterSeconds || "a few"} seconds and try again.`;
  }
  if (data?.code === "source_unavailable") {
    return "An official lookup source is temporarily unavailable. Please try again in a minute.";
  }
  return data?.error || fallback;
}

function hideSuggestions() {
  suggestionsBox.hidden = true;
  suggestionsBox.innerHTML = "";
  addressInput.setAttribute("aria-expanded", "false");
  addressInput.removeAttribute("aria-activedescendant");
  selectedSuggestionIndex = -1;
}

function selectSuggestion(index) {
  const suggestion = suggestions[index];
  if (!suggestion) return;
  addressInput.value = suggestion.text.replace(/,\s*USA$/i, "");
  hideSuggestions();
}

function renderSuggestions(items) {
  suggestions = items;
  selectedSuggestionIndex = -1;
  suggestionsBox.innerHTML = "";

  if (items.length === 0) {
    hideSuggestions();
    return;
  }

  for (const [index, suggestion] of items.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `address-suggestion-${index}`;
    option.className = "suggestion";
    option.setAttribute("role", "option");
    option.textContent = suggestion.district ? `${suggestion.text} · AD ${suggestion.district}` : suggestion.text;
    option.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      selectSuggestion(index);
    });
    suggestionsBox.append(option);
  }

  suggestionsBox.hidden = false;
  addressInput.setAttribute("aria-expanded", "true");
}

function highlightSuggestion(index) {
  const optionNodes = [...suggestionsBox.querySelectorAll(".suggestion")];
  if (optionNodes.length === 0) return;

  selectedSuggestionIndex = (index + optionNodes.length) % optionNodes.length;
  for (const [optionIndex, option] of optionNodes.entries()) {
    const isSelected = optionIndex === selectedSuggestionIndex;
    option.setAttribute("aria-selected", String(isSelected));
  }
  addressInput.setAttribute("aria-activedescendant", optionNodes[selectedSuggestionIndex].id);
}

async function fetchSuggestions(query) {
  suggestionAbortController?.abort();

  if (query.trim().length < 3) {
    hideSuggestions();
    return;
  }

  suggestionAbortController = new AbortController();
  const params = new URLSearchParams({ text: query.trim() });
  try {
    const response = await fetch(`/api/suggest?${params.toString()}`, {
      signal: suggestionAbortController.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(friendlyError(data, "Could not load address suggestions."));
    if (addressInput.value.trim() === query.trim()) {
      const nextSuggestions = data.suggestions || [];
      if (nextSuggestions.length > 0) renderSuggestions(nextSuggestions);
    }
  } catch (error) {
    if (error.name !== "AbortError" && suggestions.length === 0) hideSuggestions();
  }
}

addressInput.addEventListener("input", () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(() => fetchSuggestions(addressInput.value), 90);
});

addressInput.addEventListener("keydown", (event) => {
  if (suggestionsBox.hidden) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlightSuggestion(selectedSuggestionIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightSuggestion(selectedSuggestionIndex - 1);
  } else if (event.key === "Enter" && selectedSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestion(selectedSuggestionIndex);
  } else if (event.key === "Escape") {
    hideSuggestions();
  }
});

addressInput.addEventListener("blur", () => {
  setTimeout(hideSuggestions, 120);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideSuggestions();
  result.hidden = true;
  setStatus("Finding the district and checking official sources...");
  lookupButton.disabled = true;
  regenerateButton.disabled = true;

  const params = new URLSearchParams(new FormData(form));
  try {
    const response = await fetch(`/api/lookup?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(friendlyError(data, "Could not complete lookup."));

    currentEmail = data.member.email;
    currentPhone = data.member.phone || "";
    repName.textContent = data.member.name;
    matchedAddress.textContent = data.matchedAddress;
    districtMeta.textContent = `Assembly District ${data.district}`;
    emailMeta.textContent = data.member.email;
    emailMeta.href = `mailto:${encodeURIComponent(data.member.email)}`;
    phoneMeta.textContent = currentPhone || "Not listed";
    phoneMeta.href = currentPhone ? phoneHref(currentPhone) : "#";
    supportBadge.textContent = supporterBadgeCopy(data.supporterStatus);
    supportBadge.dataset.status = data.supporterStatus;
    renderRoleBadges(data.roles);
    renderElectionBadge(data.election);
    const checkedDate = formatCheckedDate(data.bill?.checkedAt);
    supportChecked.textContent = checkedDate ? `Support list checked ${checkedDate}` : "Support list checked from official bill page";
    callLine.hidden = !currentPhone;
    if (currentPhone) {
      callButton.href = phoneHref(currentPhone);
      callButton.textContent = `Call ${currentPhone}`;
      callScript.textContent = `After sending, call and say: “Hi, my name is ${data.senderName || "[your name]"}, I live in Assembly District ${data.district}, and I’m calling to ask Assemblymember ${data.member.name} to ${callAskCopy(data.askType)}.”`;
    }
    subjectInput.value = data.subject;
    draftInput.value = data.body;
    rebuildMailto();

    result.hidden = false;
    setStatus("Draft ready. Make it sound like you, then open it in your email app or service.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    lookupButton.disabled = false;
    regenerateButton.disabled = false;
  }
});

function supporterBadgeCopy(status) {
  if (status === "listed") return "A1466 supporter";
  if (status === "likely-listed") return "Likely A1466 supporter";
  return "Not listed as supporter";
}

function callAskCopy(askType) {
  if (askType === "leadership-health-supporter") return "move A1466 out of Health Committee and prioritize it for a floor vote, because committee action while session days remain would help keep the bill moving";
  if (askType === "leadership-health") return "co-sponsor A1466, move it out of Health Committee, and prioritize it for a floor vote, because committee action while session days remain would help keep the bill moving";
  if (askType === "leadership-supporter") return "prioritize A1466 for committee movement and a floor vote, because committee action while session days remain would help keep the bill moving";
  if (askType === "leadership") return "co-sponsor A1466 and prioritize it for committee movement and a floor vote, because committee action while session days remain would help keep the bill moving";
  if (askType === "health-supporter") return "move A1466 out of the Assembly Health Committee, because committee action while session days remain would help keep the bill moving";
  if (askType === "health") return "co-sponsor A1466 and move it out of the Assembly Health Committee, because committee action while session days remain would help keep the bill moving";
  if (askType === "supporter") return "push for A1466 to be placed on the Health Committee agenda while session days remain, because getting on the agenda is a needed step before the bill can move toward a vote";
  return "co-sponsor A1466 and publicly support the bill";
}

subjectInput.addEventListener("input", rebuildMailto);
draftInput.addEventListener("input", rebuildMailto);

mailtoButton.addEventListener("click", () => trackMetric("email_app_opened"));
gmailButton.addEventListener("click", () => trackMetric("email_app_opened"));
outlookButton.addEventListener("click", () => trackMetric("email_app_opened"));
yahooButton.addEventListener("click", () => trackMetric("email_app_opened"));
callButton.addEventListener("click", () => trackMetric("call_button_clicked"));

regenerateButton.addEventListener("click", () => {
  form.requestSubmit();
});

copyButton.addEventListener("click", async () => {
  const callLineText = currentPhone ? `\n\nFollow-up call: ${currentPhone}` : "";
  const text = `To: ${currentEmail}\nSubject: ${subjectInput.value}\n\n${draftInput.value}${callLineText}`;
  await navigator.clipboard.writeText(text);
  trackMetric("email_draft_copied");
  copyButton.textContent = "Copied";
  setTimeout(() => {
    copyButton.textContent = "Copy draft";
  }, 1400);
});
