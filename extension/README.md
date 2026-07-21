# AI Wars Bridge

Play AI Wars against ChatGPT, Claude, or Gemini through their normal web pages. No API key, no cost. The extension opens the chatbot in a background tab, sends each turn as a chat message, and reads the reply back into the game.

It is slower than the API providers, sometimes a lot slower. That is the trade: free and fun to watch, not fast.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on Developer mode (top right).
3. Click "Load unpacked" and select this `extension` folder.

## Use

1. Serve the game over localhost and open it in the same browser, for example `python3 -m http.server` in the project folder, then `http://localhost:8000/game/`. Opening `index.html` straight from disk (`file://`) does not work here, the extension cannot reach file pages.
2. In match setup, pick "CHATGPT WEB (FREE)", "CLAUDE WEB (FREE)", or "GEMINI WEB (FREE)" for one or both sides.
3. Make sure you are logged in to that chatbot in this browser.
4. Start the match. A background tab opens for each web side and the game plays through it.

Keep the chatbot tab open while the match runs. Each match uses one fresh conversation per side, so your existing chats are never touched.

## Notes

- Works on `localhost` and the hosted game at `aiwars.lol` out of the box. To use a different hosted copy, add its address to `content_scripts.matches` in `manifest.json` and reload the extension.
- If a reply never arrives, the game treats that turn as a pass and keeps going. After two provider failures in a row the game stops calling that side for the rest of the match, fix the login and hit REMATCH.
- If you reload or update the extension while the game page is open, refresh the game page too, the old bridge connection dies with the reload.
- Free chatbot tiers have message limits. A full 30 turn match sends up to 30 messages per web side.
