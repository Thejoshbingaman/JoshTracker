const fs = require('fs');
const path = require('path');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

const cityToAirport = {
  "Baltimore": "BWI",
  "Los Angeles": "LAX",
  "St. Louis": "STL",
  "Chicago": "ORD",
  "Denver": "DEN",
  "Dallas": "DAL",
  "Houston": "HOU",
  "Phoenix": "PHX",
  "Las Vegas": "LAS",
  "Orlando": "MCO",
  "Tampa": "TPA",
  "Nashville": "BNA",
  "Atlanta": "ATL"
};

async function loadSavedCredentialsIfExist() {
  try {
    const content = fs.readFileSync(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  fs.writeFileSync(TOKEN_PATH, payload);
}

async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) return client;

  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

function parseFlightEvent(event) {
  const summary = event.summary || "";
  const location = event.location || "";
  const startTime = event.start?.dateTime;

  // 1. Date (YYYY-MM-DD)
  const date = startTime ? startTime.split("T")[0] : null;

  // 2. Flight number from "(WN 332)"
  const flightNumberMatch = summary.match(/\(([A-Z]{2})\s?(\d{2,4})\)/);
  const flightNumber = flightNumberMatch
    ? flightNumberMatch[1] + flightNumberMatch[2]
    : null;

  // 3. Destination city from "Flight to Baltimore"
  let destinationCity = null;
  const toMatch = summary.match(/Flight to ([A-Za-z\s]+)/i);
  if (toMatch) {
    destinationCity = toMatch[1].trim();
  }

  // 4. Origin airport code from "St. Louis STL"
  let originCode = null;
  const originMatch = location.match(/([A-Z]{3})$/);
  if (originMatch) {
    originCode = originMatch[1];
  }

  // 5. Destination airport code from city
  const destinationCode = destinationCity ? cityToAirport[destinationCity] : null;

  return {
    flightNumber,
    originCode,
    destinationCity,
    destinationCode,
    date,
    rawSummary: summary,
    rawLocation: location
  };
}

async function fetchFlightFromBackend(flight) {
  const url = `http://localhost:3000/flight/${flight.flightNumber}/${flight.date}?origin=${flight.originCode}&destination=${flight.destinationCode}`;

  const res = await fetch(url);
  const data = await res.json();
  return data;
}

async function listEvents(auth) {
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];

  const flightEvents = events.filter(e =>
    e.summary && e.summary.startsWith("Flight")
  );

  const parsedFlights = flightEvents.map(parseFlightEvent);

  for (const flight of parsedFlights) {
    const result = await fetchFlightFromBackend(flight);
    console.log("Backend result for:", flight.flightNumber);
    console.log(JSON.stringify(result, null, 2));
  }
}

authorize().then(listEvents).catch(console.error);
