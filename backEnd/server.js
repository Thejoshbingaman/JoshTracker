require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.send('Flight Tracker Backend is running!');
});

app.get('/flight/:flightNumber/:date', async (req, res) => {
  const { flightNumber, date } = req.params;   // e.g. "WN332" and "2026-10-05"
  const { origin } = req.query;                // e.g. "BWI"

  try {
    // Ask AeroDataBox for every leg of this flight number on this date
    const aeroResponse = await axios.get(
      `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${date}`,
      {
        headers: {
          'X-RapidAPI-Key': process.env.AERODATABOX_API_KEY,
          'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
        }
      }
    );

    // If AeroDataBox found nothing, stop here
    const segments = Array.isArray(aeroResponse.data) ? aeroResponse.data : [];
    if (segments.length === 0) {
      return res.json({ error: "No flight data found" });
    }

    // FIX 3: match on the origin airport only.
    // AeroDataBox tells us the real destination, so no city map is needed.
    const correctSegment = segments.find(seg =>
      seg.departure.airport.iata === origin
    );

    if (!correctSegment) {
      return res.json({ error: "No segment departs from " + origin });
    }

    // FIX 2: upsert = insert a new row, or update the row if it already exists
    const { error } = await supabase.from('flights').upsert(
      {
        flightNumber: flightNumber,   // use "WN332" from the calendar, so it always matches
        // FIX 4: use the LOCAL departure date, not UTC
        date: correctSegment.departure.scheduledTime.local.split(" ")[0],
        origin: correctSegment.departure.airport.iata,
        destination: correctSegment.arrival.airport.iata,
        departureUtc: correctSegment.departure.scheduledTime.utc,
        departureLocal: correctSegment.departure.scheduledTime.local,
        arrivalUtc: correctSegment.arrival.scheduledTime.utc,
        arrivalLocal: correctSegment.arrival.scheduledTime.local,
        predictedArrivalUtc: correctSegment.arrival.predictedTime?.utc || null,
        predictedArrivalLocal: correctSegment.arrival.predictedTime?.local || null,
        status: correctSegment.status,
        aircraft: correctSegment.aircraft?.model || null,
        airline: correctSegment.airline?.name || null,
        lastUpdatedUtc: correctSegment.lastUpdatedUtc
      },
      { onConflict: 'flightNumber,date' }  // the rule we added in Step 2
    );

    if (error) {
      console.error("Supabase error:", error.message);
    }

    res.json(correctSegment);

  } catch (err) {
    console.error("AeroDataBox error:", err.response?.data || err.message);
    res.status(500).json({ error: "Backend error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
