/** The URL used for new WebSocket connections. */
const WS_URL = "ws://127.0.0.1:31418";
/** A prefix that is added to log messages by this addon. */
const LOG_PREFIX = "[YT live chat reader]";

/* Protocol related constants */
/** The WebSocket close signal for invalid packets. */
const WS_SIGNAL_PACKET_INVALID = [ 4001, "packet invalid" ];
/** The WebSocket close signal for high-level protocol violations. */
const WS_SIGNAL_PROTOCOL_VIOLATED = [ 4002, "protocol violated" ];
/** The packet type for informing the server about the video id of this chat. */
const WS_PACKET_VIDEO_ID = 'id';
/** The packet type for chat messages. */
const WS_PACKET_CHAT_MESSAGE = 'message';
/** The packet type for setting the addon to active or inactive. */
const WS_PACKET_ACTIVE = 'active';

(() => {
  if (window.ytLiveChatExists) {
    return;
  }
  window.ytLiveChatExists = true;

  /**
   * The current WebSocket client that is being used to communicate
   * with the server.
   */
  let currentWsClient;
  /**
   * The mutation observer that is used to get notifed about new chat messages.
   * It is inactive until messages have to be read.
   */
  let currentMutationObserver = new MutationObserver(onMutation);
  /**
   * tracks, whether the current connection is "active".
   * The is controlled by the server using the "active" package.
   * Only sends chat messages if this is true.
   */
  let isActive = false;

  info("Starting 'YT live chat reader' addon...");

  /*
  * This is basically the "main loop" of this addon.
  * Every 5 seconds, 'tryOpenConnection' is called.
  * Note that 'tryOpenConnection' only does something
  * if there is currently no connection active.
  */
  setInterval(tryOpenConnection, 5000);

  /**
    * Searches for the live chat HTML node and adds a mutation observer.
    * @returns `true`, if setup worked and messages are being read.
    *          `false`, if setup failed.
    */
  function startReadingMessages() {
    const base = document.querySelector("#items.yt-live-chat-item-list-renderer");
    if (!base) {
      // This should not happen, as this addon is only active on the live chat URL
      warn("Could not find chat messages.");
      return false;
    }
    
    currentMutationObserver.observe(base, {
      childList: true,
    });

    return true;
  }

  /**
   * Stops reading messages by removing / disabling the mutation observer
   * that was added by `startReadingMessages`.
   */
  function stopReadingMessages() {
    currentMutationObserver.disconnect();
  }

  /**
   * Called by the mutation observer eveytime the message container changed.
   * Calls `handleNewMessage` for every added chat message.
   * @param {object} events The mutation events.
   */
  function onMutation(events) {
    for (const event of events) { 
      for (const node of (event.addedNodes || [])) {
        handleNewMessage(node);
      }
    }
  }

  /**
   * Called for every new chant message. * Sends a `message` packet to the
   * current WebSocket client with the data of the HTML message node.
   * @param {object} node The HTML node of the chat message.
   */
  function handleNewMessage(node) {
    // Cancel if not active
    if (!isActive) {
      return;
    }

    // Get data from HTML node
    const messageElement = node.children[1];
    const author = messageElement?.children?.[1]?.textContent;
    const message = messageElement?.children?.[3]?.textContent;

    // Cancel if data is not what it should be
    if (typeof author !== "string" || typeof message !== "string") {
      warn("Could not get chat data from HTML message node.");
      return;
    }

    // Send packet
    sendPacket(WS_PACKET_CHAT_MESSAGE, [author, message]);
  }

  /**
   * Tries to open a connection to a server.
   * @returns 
   */
  function tryOpenConnection() {
    // Don't if there is an active connection
    if (currentWsClient && currentWsClient.readyState !== WebSocket.CLOSED) {
      return;
    }

    // Don't if we can't get a video id (there should always be one, but who knows)
    if (!getVideoId()) {
      return;
    }

    // Try to open the connection
    currentWsClient = new WebSocket(WS_URL);
    currentWsClient.addEventListener("open", onWsOpen, { once: true});
  }

  /**
   * Event handler for the WebSocket 'open' event.
   * Sends the "id" packet and adds event handlers for other events.
   */
  function onWsOpen() {
    info("WebSocket connected to server!");
    isActive = false;
    currentWsClient.addEventListener("message", onWsMessage);
    currentWsClient.addEventListener("error", onWsError);
    currentWsClient.addEventListener("close", onWsClose);
    sendPacket(WS_PACKET_VIDEO_ID, getVideoId());
  }

  /**
   * Event handler for the WebSocket 'message' event.
   */
  function onWsMessage(event) {
    const [ type, shouldBeActive ] = parsePacket(event.data);
    if (typeof type === "undefined") {
      return; // Connection has been closed by `parsePacket`
    }
    
    // Close connection if the packet is not "active".
    if (type !== WS_PACKET_ACTIVE || typeof shouldBeActive !== 'boolean') {
      warn(`Received invalid packet of type ${type} (${typeof shouldBeActive})`);
      currentWsClient.close(...WS_SIGNAL_PROTOCOL_VIOLATED);
      return;
    }

    // Switch to active
    if (shouldBeActive && !isActive) {
      isActive = true;
      startReadingMessages();
    }

    // Switch to inactive
    else if (!shouldBeActive && isActive) {
      isActive = false;
      stopReadingMessages();
    }
  }

  /**
   * Event handler for the WebSocket 'error' event.
   */
  function onWsError(event) {
    warn("WebSocket error: ", event);
  }

  /**
   * Event handler for the WebSocket 'close' event.
   */
  function onWsClose({ code, reason }) {
    stopReadingMessages();
    info(`WebSocket closed. Code: ${code} Reason: ${reason || "<not given>"}`);
  }

  /**
   * Parses a package received by the WebSocker client.
   * Closes the connection if something is wrong.
   * @param {string} package The package to parse.
   * @returns If everything is fine, an array with two values (type and parsed json data).
   *          If the data is invalid, an empty array.
   */
  function parsePacket(package) {
    if (typeof package !== "string") {
      currentWsClient.close(...WS_SIGNAL_PACKET_INVALID);
      return [];
    }

    const [ type, json ] = package.split(" ", 2);
    if (typeof json !== "string") {
      currentWsClient.close(...WS_SIGNAL_PACKET_INVALID);
      return [];
    }

    try {
      const data = JSON.parse(json);
      return [ type, data ]
    }
    catch (e) {
      currentWsClient.close(...WS_SIGNAL_PACKET_INVALID);
      return [];
    }
  }

  /**
   * Sends a packet via the current WebSocket client.
   * @param {string} type The packet type ('message', 'id')
   * @param {any} data The data to send. Will be serialized to JSON.
   */
  function sendPacket(type, data) {
    const message = `${type} ${JSON.stringify(data)}`;
    currentWsClient.send(message);
  }

  /**
   * @returns {string} The video ID this chat belongs to from the URL.
   */
  function getVideoId() {
    return new URLSearchParams(document.location.search).get("v");
  }

  /**
   * Logs an info message to the console.
   * @param  {...any} parts The message to log.
   */
  function info(...parts) {
    console.log(LOG_PREFIX, ...parts);
  }

  /**
   * Logs a warning message to the console.
   * @param  {...any} parts The message to log.
   */
  function warn(...parts) {
    console.warn(LOG_PREFIX, ...parts);
  }
})();
