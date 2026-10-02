require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.AERODATABOX_API_KEY;

async function getLiveFlightStatus(flightNumber) {
  try {
    const url = `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}`;

    const response = await axios.get(url, {
      headers: {
        'X-RapidAPI-Key': API_KEY,
        'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
      }
    });

    return response.data;
  } catch (err) {
    console.error('AeroDataBox LIVE error:', err.response?.data || err.message);
    return null;
  }
}

module.exports = getLiveFlightStatus;