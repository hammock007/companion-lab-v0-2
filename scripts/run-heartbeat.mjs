const heartbeatUrl = process.env.HEARTBEAT_URL;
const heartbeatSecret = process.env.HEARTBEAT_SECRET;

if (!heartbeatUrl) {
  console.error("HEARTBEAT_URL is missing.");
  process.exit(1);
}

if (!heartbeatSecret) {
  console.error("HEARTBEAT_SECRET is missing.");
  process.exit(1);
}

console.log("Starting Companion heartbeat...");

try {
  const response = await fetch(heartbeatUrl, {
    method: "POST",
    headers: {
      "x-heartbeat-secret": heartbeatSecret,
    },
  });

  const body = await response.text();

  console.log(`Heartbeat status: ${response.status}`);
  console.log(body);

  if (!response.ok) {
    process.exit(1);
  }

  console.log("Heartbeat completed.");
  process.exit(0);
} catch (error) {
  console.error("Heartbeat request failed:", error);
  process.exit(1);
}