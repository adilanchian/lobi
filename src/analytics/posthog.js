const { PostHog } = require("posthog-node");

const client = new PostHog("phc_oaQdzPboiA9Jm3Xk4AzaghEYBLeFy9LUVb8GR25ccqdB", {
  host: "https://us.i.posthog.com",
});

function capture(distinctId, event, properties = {}) {
  client.capture({ distinctId, event, properties });
}

function shutdown() {
  return client.shutdown();
}

module.exports = { capture, shutdown };
