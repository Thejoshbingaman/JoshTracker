const getFlightStatus = require('./getFlightStatus');   //import the getFlightStatus function from the getFlightStatus.js file

async function run() {  //function to test the getFlightStatus function and waits for the response before continuing
  const data = await getFlightStatus('WN332'); // example flight (from today)
  console.dir(data, { depth: null });   //prints response
}

run();      //runs the run function to get the flight and log the results