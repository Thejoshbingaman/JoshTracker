require('dotenv').config();     //grabs the api key from the .env file
const axios = require('axios');     //import axios for making HTTP requests

const API_KEY = process.env.AVIATIONSTACK_API_KEY;      //stores the API key from the .env file in a variable

async function testCall() {     //function to test the Aviationstack API call and waits for the response before continuing
  try {     //try block to catch any errors that may occur during the API call
    const response = await axios.get('http://api.aviationstack.com/v1/flights', {       //makes a GET request to the Aviationstack API for flight data using the API key and a limit of 1 flight in the response
      params: {
        access_key: API_KEY,        //passes the API key as a parameter in the request
        limit: 1        //limits the response to 1 flight
      }
    });

    console.log('Success! Sample flight data:');        //logs a success message to the console if the API call is successful
    console.dir(response.data, { depth: null });        //prints the response data to the console with unlimited depth for better visibility of nested objects
  } catch (err) {       //catch block to handle any errors that may occur during the API call
    console.error('Error calling Aviationstack:', err.response?.data || err.message);       //logs an error message to the console if the API call fails, displaying either the error response data or the error message
  }
}

testCall();     //runs the testCall function to initiate the API call and log the results