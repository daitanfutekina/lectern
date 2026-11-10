# Voices

Two kinds, and they stack. A **neural voice** speaks; a **character voice**
changes who it sounds like. Neither is in the repository — they are hundreds of
megabytes of model weights. Lectern can download its default neural voice;
other neural voices and character voices are installed by hand into the library.

Everything here is free and runs offline. Nothing is fetched while reading. The
one built-in download starts only when the reader clicks its button in Settings
or on an empty shelf; after that completes, speech is entirely local.

## Neural voices (Kokoro and Piper)

A voice is a folder under `<library>/.library/voices/`:

```
voices/
  vits-piper-en_GB-alba-medium/
    en_GB-alba-medium.onnx
    tokens.txt
    espeak-ng-data/
```

A folder counts as a voice when it holds an `.onnx` and a `tokens.txt`. Anything
else is ignored silently, so a half-extracted download never appears in the
picker looking like a working voice.

### Built-in download

The button installs **Lessac (en US, medium)** as
`vits-piper-en_US-lessac-medium`. The voice itself is the official Piper v1.0.0
model and configuration from `rhasspy/piper-voices` on Hugging Face:

- `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx`
  — 63,201,294 bytes, MD5 `2fc642b535197b6305c7c8f92dc8b24f`.
- `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`
  — 4,885 bytes, MD5 `c1f2b7bddefe113f3255ff9ef234cfd3`.

Those sizes and digests are the entries in the same tag's `voices.json`. The
official model needs the conversion documented by sherpa-onnx: Lectern generates
`tokens.txt` from the config and appends the required metadata to the ONNX model
locally. It takes the shared `espeak-ng-data` from the official Piper Windows
release at
`https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip`,
verified as SHA-256
`f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea`.
The executable and libraries in that archive are discarded.

All remote files are verified before installation. Work is written under the
temporary sibling `vits-piper-en_US-lessac-medium.download`; only a completed
voice is renamed to its final folder. Cancelling, losing the network, or failing
an integrity check removes the temporary folder and leaves existing voices
untouched.

Manually installed bundles come from sherpa-onnx's Piper releases, which is why
the folder names start `vits-piper-`. The settings page renders a name such as
`vits-piper-en_GB-alba-medium` as `Alba (en GB, medium)`.

A Kokoro folder is recognised by its `voices.bin`, and one Kokoro model carries
fifty-three speakers, so it becomes fifty-three entries in the picker rather
than one. The sherpa release to take is **v1.0**: the v1.1 asset is `v1.1-zh`, a
Chinese fine-tune, and is the wrong model for English. Drop a `voices.txt` beside
the model listing the speaker names in id order and the picker will use them.

Kokoro is the better engine and Piper is the faster one -- twice realtime against
twenty times -- which is why synthesis looks one sentence ahead while the current
one plays. The Windows system voices remain underneath both as a fallback.

## Character voices (RVC)

A character voice converts speech rather than generating it, so it needs the
neural voice above to have said something first.

Three models, in `<library>/.library/rvc/`:

```
rvc/
  vec-768-layer-12.onnx          the content encoder  (~360 MB, shared)
  rmvpe.onnx                     the pitch tracker    (~345 MB, shared)
  <character>/
    <anything>.onnx              the character        (~107 MB each)
```

The first two are shared by every character. The settings page distinguishes
"no character installed" from "a character is installed but the encoders are
not", because the second looks identical from the outside and does nothing.

The folder name is what appears in the picker: `teto` shows as `Teto`.

### Where the shared models come from

Both live in the Hugging Face repository `NaruseMioShirakana/MoeSS-SUBModel`:

- `vec-768-layer-12.onnx` — ContentVec, layer 12, 768 dimensions. This is what
  RVC v2 models expect.
- `RMVPE.onnx` — rename it to `rmvpe.onnx`.

**Do not substitute a HuBERT export for the content encoder.** The commonly
circulated `hubert_base.onnx` is broken in two ways that only show up at
runtime: its input is fixed at exactly 32000 samples, and a `Where` node in the
encoder mis-broadcasts 99 against 768 and throws. ContentVec takes any length
and runs at about seventeen times realtime.

### Converting a character model

RVC characters are distributed as PyTorch `.pth` files and the runtime needs
ONNX. The conversion is a one-time job and needs no Python:

```bash
node scripts/convert-rvc.mjs "C:/Library/.library/rvc/teto/model.pth"
```

The result is written beside the original. The `.pth` can then be deleted.
**Keep the `.index`** — it is what makes the voice sound like itself rather than
like a generic conversion, and it is loaded from beside the model.

Where a character offers several models, take the one trained on the most
audio; the epoch count in the file name is not the useful number.

## Pitch, and why it is not optional

A converter reproduces a voice's *timbre* but not its *range*. A base voice well
below the character sounds like that character straining, so the base is moved
up first. The **Pitch** slider does that, in semitones.

**Leaving it at zero is usually wrong, and wrong in a way that sounds like a
different problem.** Measured on the Teto model with a female base voice at
187 Hz, the conversion came out at 133 Hz — about six semitones down, a male
speaking pitch. Everything that follows from that reads as poor conversion
quality rather than as a pitch error: roughness, a voice that does not sound
like the character, and a general impression that the model is not very good.

The shift can be found by measurement rather than by ear. Convert one sentence
across a range of shifts and look at how much energy lands in the 4-8 kHz band,
where harshness lives. The model is cleanest where it is not straining, and that
is its natural range. On the Teto model:

| shift | output | 4-8 kHz | above 8 kHz |
|------:|-------:|--------:|------------:|
| +0    | C3  133 Hz | 2.2% | 3.7% |
| +6    | F#3 188 Hz | 1.3% | 2.8% |
| +8    | G#3 211 Hz | 1.1% | 2.2% |
| **+12** | **C4 264 Hz** | **1.0%** | **1.8%** |
| +14   | D4  294 Hz | 1.4% | 1.4% |
| +18   | F4  348 Hz | 3.3% | 2.2% |

Two things fall out of that. The optimum is **+12**, and past +14 the output
pitch stops following the request at all — +16, +18 and +20 gave 333, 348 and
368 Hz — which is the model refusing to go higher and marks the top of what it
was trained on. Her speaking range is about G#3 to D4.

Get this wrong and **Likeness appears to make things worse**, because a model
being asked for a pitch it cannot produce degrades further the more faithfully
you push it toward its own recordings. At +12 the same slider improves the
sound monotonically.

## Preparing, and how long it takes

Piper synthesises at roughly twenty times realtime. Conversion is roughly
realtime — measured at 0.8x cold and 1.7x with the models warm, on sixteen
threads.

That is too slow to speak on demand, so choosing a character voice makes opening
a chapter start a background job that prepares its sentences in reading order.
The bar under the chapter says how far it has got. Reading order matters: a
reader who presses play immediately is moving through the chapter at the same
speed the queue is, and in practice never catches it.

A note on the retrieval index while it is nearby: the `nprobe` stored in the
file is 1, and 1 is useless for this. The clusters were fitted around the
character's own recordings, and a query from a *different* speaker falls between
them, so the nearest-centre shortcut stops predicting where the neighbours are.
Measured against a brute-force search, one cluster found neighbours 59% as close
as the true nearest; 256 clusters found 100%, and cost nothing extra because the
time goes on comparing against the cluster centres either way.

Prepared sentences are kept, so reopening a chapter is instant. The store is at
`<library>/.library/speech/` and has no size limit — discarding a second of real
work to save a few kilobytes is the wrong trade — so settings reports its size
and can empty it.

Changing the character, the pitch, the base voice, the speed or the pacing all
change what the audio would be, so each starts the job again. Editing one
paragraph of a book costs that paragraph and nothing else: the store is keyed on
the sentence, not on its position.
