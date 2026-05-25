# NY Health Act Contact Helper

A small local web app for drafting constituent emails about the New York Health Act, A01466/A1466.

## What it does

- Takes a New York address.
- Suggests New York addresses while the user types.
- Uses the U.S. Census geocoder to find the State Assembly district.
- Fetches the official New York Assembly email list to find the Assembly member and public email address.
- Fetches the member's official Assembly contact page to find an office phone number.
- Fetches the official Assembly bill page for A01466 to check the current action and sponsor/co-sponsor listing.
- Fetches official Assembly Health Committee and Assembly leadership pages so the ask can match the member's role.
- Creates an editable email draft, opens it in the sender's own email app with a `mailto:` link, offers desktop compose links for Gmail, Outlook, and Yahoo, and provides a follow-up call prompt.

The app does not send messages automatically. The person using it reviews and sends the email themselves.

## Role-aware asks

The draft changes based on the matched Assembly member:

- If they are not listed as a supporter, the ask is to co-sponsor and publicly support A1466.
- If they are already listed as a supporter, the ask is to push for A1466 to be placed on the Health Committee agenda before June 10.
- If they are on the Assembly Health Committee, the ask is to move A1466 out of committee this session.
- If they are in Assembly leadership, the ask is to prioritize the bill for committee movement and a floor vote.

When a member has more than one status or role, the draft combines the relevant asks. For example, a non-supporter on the Health Committee is asked to co-sponsor A1466 and move it out of committee, while a supporter in leadership is thanked for their support and asked to prioritize committee movement and a floor vote.

The page also shows role badges for Health Committee members and Assembly leadership. If a member has more than one role, badges are stacked with the highest-priority role first.

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
