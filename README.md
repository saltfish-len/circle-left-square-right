# Circle Left, Square Right

A browser game for two-handed coordination: your left hand draws a circle while your right hand draws a square, at the same time. Your index fingertips are the pens, tracked through the webcam with [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).

**Play:** https://saltfish-len.github.io/circle-left-square-right/

Everything runs locally in the browser. Camera frames are never uploaded.

## How to play

1. Click **Start with camera** and allow camera access. Raise both hands into view with your **index fingers pointing up**, like you're asking a question. Don't aim a fingertip at the camera: when it points at the lens, the tracker pulls the tip back onto the knuckle.
2. Hold both fingertips on the start dots until the ring fills.
3. Draw both shapes in one stroke each, back to their end points. Closed shapes can go either way round.

Your score is each hand's shape accuracy (30% each) plus how well the two hands kept pace with each other (40%). The result screen plots both hands' progress over time and gives you one tip on what to improve.

There are nine levels, from circle/square to hearts, stars, waves and spirals.

### Other modes

- **Two-finger touch** (touch screens): draw directly on the screen, one finger on each half.
- **Try with mouse** (desktop): the mouse is your right hand and the left hand follows it automatically, so you can see how a round works.

On phones the game runs in landscape. Held upright, it asks you to turn the phone.

### Keys

`←` / `→` change shapes · `R` restart · `+` / `−` shape size · `V` camera view on/off · `[` / `]` and `↑` / `↓` framing · `D` debug overlay · `Esc` quit

## Run locally

Any static file server works. The camera needs a secure context, so use `localhost`:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## How it works

- **Fingertip → screen.** The mirrored camera image fills the screen, zoomed in slightly to show only the upper part of the frame. Your hands then stay fully in view, wrists included, while you draw low on the screen; with the wrist out of frame, MediaPipe struggles to tell the index finger from the thumb. The cursor is landmark 8 (index tip), smoothed with a [One Euro filter](https://gery.casiez.net/1euro/).
- **Left and right** are assigned by position, keeping each hand's palm continuous from frame to frame, rather than by MediaPipe's handedness label. Duplicate detections of one hand are merged.
- **Starting.** Both fingertips must rest on their start dots until the ring fills (0.7 s). After that, each hand's stroke begins the moment it leaves its dot, so a late start counts against your sync score.
- **Progress** along each shape is the nearest point on the template, searched only in a window around the current position. That stops it jumping across a star's crossings or between a spiral's turns.
- **Shape score.** The ink is first shifted to line up with the template, so a small overall offset isn't penalised. The score is the two-way RMS distance between ink and template (wobble, missed parts, rounded corners), multiplied by how much of the template was covered.
- **Sync score** is the time-averaged difference between the two hands' progress, from the first hand leaving its start dot until both are done.

### Files

| File | |
|---|---|
| `index.html` | the game: layout, rounds, input modes, drawing |
| `hands.js` | MediaPipe loading, camera, One Euro filter |
| `tips.js` | duplicate removal, left/right assignment, optional fingertip sanity checks |
| `strokes.js` | shapes, levels, progress tracking, scoring |

### Adding a shape

Add an entry to `SHAPES` in `strokes.js`: a polyline in unit coordinates (centre at 0,0, half-width about 1, y down), with `points[0]` as the start and `closed` saying whether it's a loop. Then pair it with another shape in `LEVELS`. Scoring constants live in `TUNE`.

## TODO

- [ ] **Level editor**: create and share levels in the browser instead of editing `strokes.js`
  - [ ] **Mirrored pairs**: both hands draw the same shape as mirror images of each other (`mirrorLeft` / `mirrorRight` already exist in `LEVELS`; the editor needs to expose them)
  - [ ] **Split shapes**: the left hand draws the top half of a figure and the right hand draws the bottom half, and the two halves join into one picture on the result screen
