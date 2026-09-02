# Listening presence API

Haven can show what you are listening to on your profile. Any music player that
supports plugins or scripting can report your current track by posting to a
personal webhook URL, and a short standalone script works just as well.

## Getting your webhook URL

1. Open Settings, then the Activity section.
2. Turn on "Listening".
3. Copy the webhook URL. It looks like this:

   https://your-haven-host/api/webhooks/listening/<token>

The token is a secret. Anyone who has your URL can post to your profile, so treat
it like a password. If it ever leaks, turn the feature off and back on to generate
a new token. The old URL stops working right away.

## The endpoint

POST https://your-haven-host/api/webhooks/listening/<token>

Send the fields as a normal form body. Two content types are accepted:

- application/x-www-form-urlencoded for text only.
- multipart/form-data when you also send cover art.

No API key or header is needed. The token in the URL is the only credential.

## Fields

Required:

| Field    | Type    | Notes                                                        |
| -------- | ------- | ------------------------------------------------------------ |
| title    | text    | The track title.                                             |
| artist   | text    | The performer. An empty value is allowed but not advised.    |
| duration | integer | Total track length in whole seconds. Must be more than zero. |

Optional:

| Field    | Type    | Notes                                                             |
| -------- | ------- | ----------------------------------------------------------------- |
| album    | text    | The album name.                                                   |
| position | integer | How many seconds into the track you are now. Defaults to 0.       |
| state    | text    | playing, paused, stopped, expired, or heartbeat. Default playing. |
| source   | text    | The app reporting this, such as Navidrome, Jellyfin, or MPD.      |
| cover    | file    | Cover art image. Up to 512 KB. JPEG, PNG, GIF, or WebP.           |

Text fields have length limits (title 120, artist 80, album 120, source 40).
Longer values are trimmed. Invisible control characters are removed. Ordinary
special characters in titles and names are fine and are shown safely, so you do
not need to strip or escape anything yourself.

## States

- playing: You are listening now. Sets or updates your current track.
- paused: The track is paused. Haven keeps showing it with a paused marker.
- stopped: Nothing is playing. Clears your current track.
- expired: Same effect as stopped. Use whichever word fits your player.
- heartbeat: A keep alive for long tracks. See Expiry and heartbeats below.

## How Haven tells one track from the next

You do not send a track id. Haven works out whether an update belongs to the
current track or a new one by looking at the title, artist, and duration
together. If all three match the current track, the update is treated as the
same track, for example a position change or a pause. If any of the three
differ, it is treated as a new track and the cover art refreshes.

This is why a heartbeat has to carry the same title, artist, and duration as the
track it is meant to keep alive.

## Expiry and heartbeats

Haven clears your track automatically so a status can never get stuck. You do not
have to send a stop, although you can.

While playing, the track is kept until it would naturally end, plus a few
seconds, up to a maximum of 60 minutes. While paused, it is kept for 5 minutes of
silence.

For most music you never do anything special. A three minute song clears itself
when it ends. A normal album or set clears on its own too.

For media longer than 60 minutes, such as a long concert or a radio stream, you
have to check in at least once an hour or Haven will clear it. Anything that
reaches the webhook counts as checking in:

- A normal update such as a pause, a resume, or a seek.
- An explicit heartbeat when nothing else is changing.

A heartbeat is a post with state set to heartbeat and the same title, artist, and
duration as the current track. You can include an updated position to keep the
progress bar accurate. If the title, artist, and duration do not match the
current track, the heartbeat is ignored.

## Cover art

Cover art is optional. When you send it, Haven keeps the image in memory and
shows it to people who view your profile. It is replaced each time the track
changes, so you only need to send it on a track change, not on every update. If
you leave it out on a same track update, the current cover stays in place.

## Responses

- 204 No Content: The post was accepted. This is the normal success reply.
- 400 Bad Request: A required field is missing or invalid, or the cover is not a
  supported image.
- 404 Not Found: The token does not match any user. Usually the feature is turned
  off or the URL is old.

## Rate limits

- The webhook accepts up to 60 posts per minute.
- Cover images are served to viewers under a separate, higher limit.

Normal playback stays well under these. One post per track change, plus the
occasional heartbeat, is plenty.

## Examples

Report a track that is playing, with cover art:

    curl -X POST https://your-haven-host/api/webhooks/listening/<token> \
      -F "title=Numb" \
      -F "artist=Linkin Park" \
      -F "album=Meteora" \
      -F "duration=187" \
      -F "position=42" \
      -F "state=playing" \
      -F "source=Navidrome" \
      -F "cover=@cover.jpg"

Update the same track to paused (text only, no cover needed):

    curl -X POST https://your-haven-host/api/webhooks/listening/<token> \
      -d "title=Numb" \
      -d "artist=Linkin Park" \
      -d "duration=187" \
      -d "position=120" \
      -d "state=paused"

Send a heartbeat for a long stream:

    curl -X POST https://your-haven-host/api/webhooks/listening/<token> \
      -d "title=Live Set" \
      -d "artist=Some DJ" \
      -d "duration=7200" \
      -d "position=3600" \
      -d "state=heartbeat"

Clear your status:

    curl -X POST https://your-haven-host/api/webhooks/listening/<token> \
      -d "state=stopped"

A minimal reporter needs only four things: the title, the artist, the duration,
and your webhook URL. Everything else is optional.

## Notes

- Keep your webhook URL private.
- Haven only shows your track while you are online in the app.
- If several sources could report at once, the last accepted post wins.
