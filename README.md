# Tell Albany

A small web app for helping New Yorkers find their State Assembly member and draft a constituent message about the New York Health Act, A01466/A1466.

## What it does

- Takes a New York address.
- Suggests real New York addresses while the user types.
- Uses the U.S. Census geocoder to find the State Assembly district.
- Fetches the official New York Assembly email list to find the Assembly member and public email address.
- Fetches the member's official Assembly contact page to find an office phone number.
- Fetches the official Assembly bill page for A01466 to check the current action and sponsor/co-sponsor listing.
- Fetches official Assembly Health Committee and Assembly leadership pages so the ask can match the member's role.
- Creates an editable email draft with rotating plain-language variations so messages do not all sound identical.
- Opens the draft in the sender's own email app with a `mailto:` link.
- Shows branded Gmail, Outlook, and Yahoo compose links on desktop.
- Provides a matching follow-up call prompt and phone button when an office number is available.
- Includes rate limiting and user-facing error states for address lookup and official-source failures.
- Includes a Learn More/FAQ section with plain-language context and source links.

The app does not send messages automatically. The person using it reviews and sends the email themselves.

## Role-aware asks

The draft changes based on the matched Assembly member:

- If they are not listed as a supporter, the ask is to co-sponsor and publicly support A1466.
- If they are already listed as a supporter, the ask is to push for A1466 to be placed on the Health Committee agenda while session days remain.
- If they are on the Assembly Health Committee, the ask is to move A1466 out of committee this session.
- If they are in Assembly leadership, the ask is to prioritize the bill for committee movement and a floor vote.

When a member has more than one status or role, the draft and follow-up call script combine the relevant asks. For example, a non-supporter on the Health Committee is asked to co-sponsor A1466 and move it out of committee, while a supporter in leadership is thanked for their support and asked to prioritize committee movement and a floor vote.

The page also shows compact role badges for Health Committee members and Assembly leadership. If a member has more than one role, badges are stacked with the highest-priority role first. The visible badges stay short, such as `Leadership`, `Health Chair`, and `Health Committee`, while the full official role remains available as the badge label.

## User flow

1. The user enters their name and New York address.
2. Address suggestions appear after a few characters so the user can choose a real match.
3. The app finds the Assembly district and shows the matched Assembly member.
4. The app shows supporter status, any Health Committee or leadership badges, the matched address, district, email, and phone number.
5. The user reviews and edits the generated email draft.
6. The user opens the draft in their email app or, on desktop, chooses Gmail, Outlook, or Yahoo.
7. After sending, the user can use the follow-up call script and call button.

## Production notes

- The public site is intended to run at `https://tellalbany.org`.
- Render serves the Node app and handles the production deploy.
- The apex domain should point to Render with an `A` record for `@`.
- The `www` subdomain should point to the Render service with a `CNAME`.
- Render should have both `tellalbany.org` and `www.tellalbany.org` added as custom domains, with `www` redirecting to the apex domain.
- Certificates can take time to issue after DNS verifies.

## Run it

```sh
npm start
```

Then open:

```text
http://127.0.0.1:4173
```

If that port is busy, run:

```sh
PORT=4174 npm start
```

## Put it online

This app needs a Node host because address lookup, Assembly contact lookup, bill-status lookup, and rate limiting all run through `server.js`.

### Easiest path: Render

1. Put this folder in a GitHub repository.
2. Go to Render and create a new **Blueprint** from that repository.
3. Render will read `render.yaml`, install dependencies, run `npm start`, and check `/healthz`.
4. After deploy, open the public Render URL and test one New York address.

The app uses official public sources at request time. No API keys are required.

### Other hosts

Most Node hosts also work. Use:

```sh
npm install
npm start
```

The host should provide a `PORT` environment variable. If it also requires a host value, use:

```sh
HOST=0.0.0.0
```

## Sources

- Assembly member email list: `https://nyassembly.gov/mem/email/`
- A01466 bill page: `https://nyassembly.gov/leg/?Actions=Y&Memo=Y&Summary=Y&bn=A01466&default_fld=&leg_video=&term=2025`
- Assembly Health Committee membership: `https://www.nyassembly.gov/comm/?id=19&sec=mem`
- Assembly leadership: `https://www.assembly.ny.gov/mem/leadership/`
- District lookup: `https://geocoding.geo.census.gov/`
- Address suggestions: `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest`
