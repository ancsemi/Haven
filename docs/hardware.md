# How much hardware does Haven need?

Very little. A Haven server is one Node.js process and one SQLite file. With
nobody connected it holds about 100 MB of memory and uses no measurable
processor time. The numbers below were measured, and you can
[repeat them on your own machine](#run-it-yourself) with one command.

## The short version

| Community | What runs it comfortably |
|---|---|
| Friends and family, up to about 50 people online | Anything that runs Node.js 22: a Raspberry Pi 4, an old laptop, the smallest VPS. 512 MB of free memory is plenty. |
| Up to about 500 people online | 1 processor core and 1 GB of memory. A Raspberry Pi 5 or a small VPS. |
| 1,000 to 2,000 people online | 1 fast core (a second one helps with uploads and backups) and 2 GB of memory. |
| More than that in one busy channel | The fastest single core you can get. One Haven process does its chat work on one core, so a faster core helps here and more cores do not. |

"Online" means connected at the same moment. A community usually has several
times more members than it ever has online at once.

## What was measured

Haven 4.29 (in development), 10 November 2026, on a desktop PC: Intel Core
i7-14700K, 64 GB memory, Windows 11, Node.js 26.12. Each row is a separate
run against a fresh throwaway server. Everyone is online and in the same
channel (plus 20 other channels each), and messages arrive nonstop at the
rate shown.

| People online | Memory (peak) | Chat rate | Processor while chatting | Busiest second | Message delay (typical / slow) | Sent to clients |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 113 MB | 1 msg/s | 0.3% | 5% | 1 ms / 4 ms | 3 KB/s |
| 50 | 128 MB | 2 msg/s | 0.6% | 5% | 1 ms / 2 ms | 35 KB/s |
| 100 | 129 MB | 2 msg/s | 1.2% | 8% | 2 ms / 3 ms | 70 KB/s |
| 250 | 173 MB | 5 msg/s | 3.0% | 31% | 2 ms / 4 ms | 437 KB/s |
| 500 | 218 MB | 10 msg/s | 6.9% | 23% | 3 ms / 6 ms | 1.7 MB/s |
| 1,000 | 284 MB | 15 msg/s | 13% | 28% | 6 ms / 10 ms | 5.2 MB/s |
| 2,000 | 343 MB | 20 msg/s | 32% | 59% | 9 ms / 18 ms | 13.8 MB/s |

How to read it:

- **Processor numbers are a share of one core.** 13% means about an eighth of
  a single core was busy, on a machine with many cores.
- **The chat rates are a stress test.** Twenty messages a second is 1.7
  million messages a day in one channel. A real community of the same size
  sends a small fraction of that, so treat every row as a ceiling.
- **Memory is the most the server held** at any point in the run, including
  everyone connecting at once. With everyone connected and nobody talking,
  processor use was under 2% at every size.
- **Message delay** is the time from one person sending a message to
  everyone else receiving it. The fake people run on the same machine, so
  there is no internet in that number.
- **The heaviest moment is everyone arriving at once**, for example after a
  server restart. With 2,000 people connecting together, the busiest
  second used 82% of one core. With 100 it used 26%.
- Every message was delivered in every run, and the server started in under
  a second.

## Smaller machines (estimates, not measurements)

Nobody has run this benchmark on a Raspberry Pi yet, so the table below is
arithmetic, not a measurement. In published Geekbench 6 single-core scores
the test PC is roughly 4 times as fast as a Raspberry Pi 5 and roughly 10
times as fast as a Raspberry Pi 4. Scaling the measured processor use by
those factors:

| People online, chat rate | Test PC (measured) | Pi 5 (estimate) | Pi 4 (estimate) |
|---|---:|---:|---:|
| 50 people, 2 msg/s | 0.6% | about 2% | about 6% |
| 100 people, 2 msg/s | 1.2% | about 5% | about 12% |
| 250 people, 5 msg/s | 3.0% | about 12% | about 30% |
| 500 people, 10 msg/s | 6.9% | about 28% | about 70% |
| 1,000 people, 15 msg/s | 13% | about 50% | more than one core |

A general benchmark score is a rough stand-in for this kind of work, so
expect the real numbers to be off in either direction. If you run Haven on a
Pi or any other small machine, run the benchmark and send us what it prints.
Real numbers will replace these estimates.

## Memory

About 100 MB for the server itself, plus roughly a quarter of a megabyte for
each person online. The database cache is capped at about 40 MB however
large the message history grows, so memory does not climb with the age of
the server.

## Disk

- **Haven itself:** about 200 MB installed, most of it the Node.js packages.
  The download is 8 MB.
- **Messages:** about half a kilobyte each, measured on a real server's
  database with everything counted (indexes and search included). A million
  messages is about 500 MB.
- **Uploads:** whatever your community uploads. This is where the disk
  goes on most servers. The admin sets the upload size limit, and files can
  be kept in S3-compatible storage instead of on the server's disk.

## Network

Each message costs about 360 bytes per person who receives it, so upload
use is roughly `people online x messages per second x 360 bytes`. A hundred
people online and a message every two seconds is about 18 KB/s.

Voice, video and screen sharing go directly between the people in the call.
The server only passes the small setup messages, so a call costs it next to
nothing, and call quality depends on the participants' own connections. The
exception is the optional voice relay (Large Server Setup), which carries
the call through the server and needs processor time and bandwidth for it.
The relay is off by default and is not part of these numbers.

## Not covered here

- The optional voice relay, as above.
- Uploads. Storing a file is cheap, and removing location data from an
  uploaded video is a short burst of processor work.
- The optional AI moderation, which has its own requirements in
  [automod.md](automod.md).
- Push notifications to people who are offline. `scripts/loadtest.js` can
  measure them with `--offline N`.

## Run it yourself

From a copy of the source with its packages installed (`npm install`):

```bash
node scripts/benchmark.js
```

It starts a throwaway server on port 3990 with an empty data folder, runs
each community size in turn, prints the table above for your machine and
deletes the data folder. It never touches a real server. Each size takes a
minute or two. Options:

```bash
node scripts/benchmark.js --sizes 10,50,100,250 --seconds 20 --port 3990
```

For one size in full detail (people arriving, chat, reconnects, status
changes, new channels), use the load tester it is built on:

```bash
node scripts/loadtest.js --users 500 --rate 5
```

The fake people run on the same machine as the server. Their processor time
is not counted in the server's numbers, but on a small machine they compete
with the server for it, so message delay will read worse than it would with
real people on their own devices.
