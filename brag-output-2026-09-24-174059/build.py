"""Builds composition/index.html for the 1-minute tryoncam spot.

Every scene, tween and sound effect is placed relative to the voice lines in
composition/assets/vo/, measured at build time, so changing a gap below re-times the edit.
Run: python3 build.py
"""
import json, subprocess

def dur(path):
    return float(subprocess.check_output(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).decode())

LEAD, TAIL = 0.4, 3.2
# Silence after each line (seconds): this is where the visuals get to breathe.
GAP = [0.7, 0.9, 0.9, 1.4, 1.2, 0.6, 1.2, 0.5, 0.5, 0.8, 1.6, 0.5, 0.9, 0.9, 0.9, 1.2,
       0.5, 0.5, 0.9, 1.6, 0.35, 0.35, 1.0, 0.5, 0.6]
N = 26
D = [dur(f'composition/assets/vo/l{i:02d}.wav') for i in range(1, N + 1)]
T = []
t = LEAD
for i in range(N):
    T.append(round(t, 2))
    t += D[i] + (GAP[i] if i < len(GAP) else 0)
END = round(T[-1] + D[-1] + TAIL, 2)

def L(n, frac=0.0):
    """Time at a fraction of the way through voice line n (1-based)."""
    return round(T[n - 1] + frac * D[n - 1], 2)

# ---- scene windows ----
S = {
    'prob':  (0, L(2) - 0.1),
    'see':   (L(2) - 0.1, L(3) - 0.1),
    'hook':  (L(3) - 0.1, L(4) - 0.2),
    'rev':   (L(4) - 0.2, L(5) - 0.3),
    'find':  (L(5) - 0.3, L(8) - 0.1),
    'you':   (L(8) - 0.1, L(12) - 0.1),
    'swap':  (L(12) - 0.1, L(17) - 0.1),
    'no':    (L(17) - 0.1, L(20) - 0.1),
    'web':   (L(20) - 0.1, L(21) - 0.1),
    'std':   (L(21) - 0.1, L(24) - 0.15),
    'out':   (L(24) - 0.15, END),
}
XF = 0.4  # overlap for the dissolve into the next scene
ORDER = list(S)
def clip(name):
    a, b = S[name]
    if name != ORDER[-1]:
        b += XF  # the outgoing scene stays underneath while the next one resolves
    return f'data-start="{a:.2f}" data-duration="{b - a:.2f}" data-track-index="0"'

# ---- sound effects: (file, time, volume, length) ----
FX = []
def fx(f, at, vol=0.6, length=0.6, auto=False):
    # Automatic accents step aside when a hand-placed sound already sits there.
    if auto and any(abs(x[1] - at) < 0.1 for x in FX):
        return
    FX.append((f, round(at, 2), vol, length))
AUTO = []  # accents placed after the hand-placed ones, so they can step aside

# ---- timeline code ----
JS = []
def js(line):
    JS.append(line)

PILL_TIP = {0: (172, 262), 1: (492, 262), 2: (812, 262), 3: (172, 584), 4: (492, 584), 5: (812, 584)}
PRODUCTS = ['f-heritage', 'f-love', 'f-pinstripe', 'f-shorts', 'f-coral', 'f-cocaine']
# The store grid: each Try On shows him in that exact garment (see the feeds below).
STORE = ['g-pink', 'g-blue', 'f-pinstripe', 'f-cocaine', 'f-coral', 'g-leopard']

def store(prefix, feeds, caps):
    pills = ''.join(
        f'<div class="prod"><img src="assets/img/{p}.jpg" alt="" /><div class="pill" id="{prefix}p{i}">Try On</div></div>'
        for i, p in enumerate(STORE))
    feed_imgs = ''.join(f'<img id="{prefix}f{i}" class="feed" src="assets/img/{f}.jpg" alt="" />' for i, f in enumerate(feeds))
    feed_imgs += ''.join(f'<i class="scan" id="{prefix}s{i}"></i>' for i in range(1, len(feeds)))
    cap_divs = ''.join(f'<div id="{prefix}c{i}" class="cap display">{c}</div>' for i, c in enumerate(caps))
    return f'''
        <div id="{prefix}stage" class="stage">
          <div class="browser" id="{prefix}browser">
            <div class="bar"><i></i><i></i><i></i><div class="url">yourfavouritestore.com/new-in</div><img class="ext" src="assets/img/logo-mark.svg" alt="" /></div>
            <div class="grid">{pills}</div>
          </div>
          <div class="panel" id="{prefix}panel">
            <div class="head"><img src="assets/img/logo-mark.svg" alt="" />tryoncam<span class="dot"></span><span class="chip">2 sessions</span><span class="status">Live</span></div>
            <div class="body">{feed_imgs}<div class="meter" id="{prefix}meter">LIVE</div></div>
          </div>
          {cap_divs}
          <svg class="cursor" id="{prefix}cursor" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.6 25 L16.8 23.6 L13.3 16.3 L20 16.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>'''

def click(prefix, pill, at):
    js(f'tl.to("#{prefix}p{pill}", {{ scale: 0.88, background: "#000", duration: 0.08, yoyo: true, repeat: 1 }}, {at});')
    js(f'tl.to("#{prefix}cursor", {{ scale: 0.84, duration: 0.08, yoyo: true, repeat: 1, transformOrigin: "10% 10%" }}, {at});')
    fx('click2.ogg', at - 0.02, 0.75, 0.3)

def move(prefix, to, at, d=0.6):
    if d >= 0.5:
        AUTO.append(('whoosh-short.wav', at + 0.05, 0.22, 0.45))
    x, y = PILL_TIP[to] if isinstance(to, int) else to
    js(f'tl.to("#{prefix}cursor", {{ x: {x}, y: {y}, duration: {d}, ease: "power3.inOut" }}, {round(at, 2)});')

def rise(sel, at, d=0.42):
    AUTO.append(('drop_002.ogg', at, 0.4, 0.4))
    js(f'tl.fromTo("{sel}", {{ y: 70, opacity: 0, scale: 0.94 }}, {{ y: 0, opacity: 1, scale: 1, duration: {d}, ease: "back.out(1.8)" }}, {round(at, 2)});')

def punch(sel, at):
    js(f'tl.fromTo("{sel}", {{ scale: 1.07 }}, {{ scale: 1, duration: 0.5, ease: "power3.out" }}, {round(at, 2)});')

def cap(sel, on, off=None):
    AUTO.append(('click_003.ogg', on, 0.45, 0.2))
    js(f'tl.fromTo("{sel}", {{ y: 36, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.3, ease: "power3.out" }}, {round(on, 2)});')
    if off is not None:
        js(f'tl.to("{sel}", {{ opacity: 0, y: -16, duration: 0.18 }}, {round(off, 2)});')

# Scene changes: the incoming scene resolves out of a blur over the outgoing one.
for name in ORDER[1:]:
    js(f'tl.fromTo("#s-{name}", {{ opacity: 0, filter: "blur(18px)" }}, {{ opacity: 1, filter: "blur(0px)", duration: {XF}, ease: "power2.out" }}, {S[name][0]:.2f});')

# Scene transitions get a whoosh.
for name in ['see', 'hook', 'find', 'you', 'swap', 'no', 'web', 'std']:
    fx('whoosh-short.wav', S[name][0] - 0.12, 0.55, 0.45)
fx('whoosh-long.wav', S['rev'][0] - 0.25, 0.6, 0.7)
fx('whoosh-long.wav', S['out'][0] - 0.3, 0.6, 0.7)

# 1 · problem
rise('#pr1', L(1))
rise('#pr2', L(1, 0.45))
js(f'tl.fromTo("#pr-strike", {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.4, ease: "power4.out" }}, {L(1, 0.85)});')
fx('impactPunch_medium_000.ogg', L(1, 0.5), 0.6)
fx('impactSoft_medium_001.ogg', L(1, 0.85), 0.5)

# 2 · you can see the clothes... but not yourself
punch('#see-stage', S['see'][0])
js(f'tl.fromTo("#see-page", {{ x: -120, opacity: 0 }}, {{ x: 0, opacity: 1, duration: 0.5, ease: "power4.out" }}, {S["see"][0]});')
rise('#see1', L(2, 0.05))
rise('#see2', L(2, 0.5))
js(f'tl.fromTo("#see-ghost", {{ scale: 0.7, opacity: 0, rotation: -8 }}, {{ scale: 1, opacity: 1, rotation: 4, duration: 0.5, ease: "back.out(1.8)" }}, {L(2, 0.55)});')
fx('drop_002.ogg', L(2, 0.05), 0.55, 0.4)
fx('impactSoft_medium_004.ogg', L(2, 0.55), 0.55)

# 3 · hook
rise('#h1', L(3))
js(f'tl.fromTo("#h2", {{ scale: 1.6, opacity: 0, filter: "blur(18px)" }}, {{ scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.4, ease: "expo.out", transformOrigin: "0% 60%" }}, {L(3, 0.3)});')
js(f'tl.fromTo("#hook-under", {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.45, ease: "power4.out" }}, {L(3, 0.45)});')
rise('#h3', L(3, 0.62))
fx('impactSoft_medium_001.ogg', L(3, 0.3), 0.6)
fx('drop_002.ogg', L(3, 0.62), 0.5, 0.4)

# 4 · reveal
a = S['rev'][0]
js(f'tl.fromTo("#rev-wipe", {{ scale: 0 }}, {{ scale: 1, duration: 0.55, ease: "power3.inOut" }}, {a});')
js(f'tl.fromTo("#rev-mark", {{ scale: 0, rotation: -25, opacity: 0 }}, {{ scale: 1, rotation: 0, opacity: 1, duration: 0.5, ease: "back.out(2.4)" }}, {L(4)});')
js(f'tl.fromTo("#rev-word span", {{ y: 120, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.4, ease: "back.out(1.6)", stagger: 0.08 }}, {L(4, 0.05)});')
rise('#rev-sub', L(4, 0.3))
js(f'tl.fromTo("#rev-bar", {{ y: 40, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.45, ease: "back.out(1.6)" }}, {L(4, 0.62)});')
js(f'tl.fromTo("#rev-ext", {{ scale: 0.6 }}, {{ scale: 1.25, duration: 0.25, ease: "power2.out", yoyo: true, repeat: 3 }}, {L(4, 0.75)});')
fx('impactSoft_heavy_003.ogg', a, 0.55)
fx('bong_001.ogg', L(4), 0.6, 0.5)
fx('drop_002.ogg', L(4, 0.3), 0.5, 0.4)
fx('switch_007.ogg', L(4, 0.75), 0.6, 0.3)

# 5 · find → hit try on → see it on you
a = S['find'][0]
punch('#fi-stage', a)
js(f'tl.fromTo("#fi-browser", {{ x: -140, opacity: 0 }}, {{ x: 0, opacity: 1, duration: 0.5, ease: "power4.out" }}, {a});')
js(f'tl.fromTo("#fi-stage .pill", {{ scale: 0.5, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.28, ease: "back.out(2.4)", stagger: 0.1, transformOrigin: "20% 50%" }}, {round(a + 0.5, 2)});')
for k in range(6):
    fx('rollover2.ogg', a + 0.5 + k * 0.1, 0.45, 0.2)
rise('#fi-c0', L(5))
js(f'tl.to("#fi-c0", {{ opacity: 0, y: -30, duration: 0.2 }}, {L(6) - 0.15});')
js(f'tl.fromTo("#fi-cursor", {{ x: 1050, y: 980, opacity: 0 }}, {{ x: 700, y: 700, opacity: 1, duration: 0.6, ease: "power2.out" }}, {L(5)});')
move('fi-', (560, 450), L(5, 0.7), 0.7)
move('fi-', 0, L(6) - 0.55, 0.55)
cap('#fi-c1', L(6), L(7) - 0.1)
click('fi-', 0, L(6, 0.55))
js(f'tl.fromTo("#fi-panel", {{ y: 80, scale: 0.9, opacity: 0 }}, {{ y: 0, scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.5)" }}, {L(6, 0.75)});')
fx('card-slide-1.ogg', L(6, 0.75), 0.55)
fx('shimmer.wav', L(6, 0.85), 0.4, 0.7)
js(f'tl.fromTo("#fi-f0", {{ scale: 1.14 }}, {{ scale: 1.03, duration: 3, ease: "sine.inOut" }}, {L(6, 0.75)});')
cap('#fi-c2', L(7))
fx('impactGlass_light_002.ogg', L(7, 0.6), 0.5, 0.5)

# 6 · not a model, not a product photo — you, live
a = S['you'][0]
punch('#yo-stage', a)
js(f'tl.fromTo("#yo-model", {{ x: -200, opacity: 0, rotation: -8 }}, {{ x: 0, opacity: 1, rotation: -4, duration: 0.45, ease: "power4.out" }}, {L(8)});')
js(f'tl.fromTo("#yo-x1", {{ scale: 2.5, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.25, ease: "back.out(2)" }}, {L(8, 0.45)});')
rise('#yo-t1', L(8))
js(f'tl.fromTo("#yo-photo", {{ x: 200, opacity: 0, rotation: 8 }}, {{ x: 0, opacity: 1, rotation: 4, duration: 0.45, ease: "power4.out" }}, {L(9)});')
js(f'tl.fromTo("#yo-x2", {{ scale: 2.5, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.25, ease: "back.out(2)" }}, {L(9, 0.5)});')
rise('#yo-t2', L(9))
fx('impactPunch_medium_000.ogg', L(8, 0.45), 0.55)
fx('impactPunch_medium_000.ogg', L(9, 0.5), 0.55)
js(f'tl.to(["#yo-model", "#yo-t1"], {{ x: -900, opacity: 0, duration: 0.35, ease: "power3.in" }}, {L(10) - 0.2});')
js(f'tl.to(["#yo-photo", "#yo-t2"], {{ x: 900, opacity: 0, duration: 0.35, ease: "power3.in" }}, {L(10) - 0.2});')
fx('whoosh-short.wav', L(10) - 0.25, 0.5, 0.45)
js(f'tl.fromTo("#yo-live", {{ scale: 0.6, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.6)" }}, {L(10) - 0.05});')
js(f'tl.fromTo("#yo-you", {{ scale: 2.2, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.35, ease: "expo.out" }}, {L(10)});')
js(f'tl.fromTo("#yo-feed", {{ scale: 1.14 }}, {{ scale: 1.03, duration: 4, ease: "sine.inOut" }}, {L(10)});')
fx('impactBell_heavy_000.ogg', L(10), 0.45, 1.2)
fx('switch_007.ogg', L(11), 0.55, 0.3)
js(f'tl.to("#yo-you", {{ opacity: 0, scale: 0.9, duration: 0.25 }}, {L(11) - 0.1});')
cap('#yo-c', L(11))
for k, s in enumerate(['#yo-m14', '#yo-m13', '#yo-m12']):
    prev = ['#yo-m15', '#yo-m14', '#yo-m13'][k]
    js(f'tl.set("{prev}", {{ opacity: 0 }}, {round(L(10) + 1 + k, 2)}); tl.set("{s}", {{ opacity: 1 }}, {round(L(10) + 1 + k, 2)});')
    AUTO.append(('click_003.ogg', L(10) + 1 + k, 0.35, 0.2))

# 7 · swap, try another, and another, until you find the one
a = S['swap'][0]
punch('#sw-stage', a)
js(f'tl.set("#sw-cursor", {{ x: 700, y: 760 }}, {a});')
cap('#sw-c0', L(12), L(13) - 0.1)
steps = [(13, 4, 1), (14, 5, 2), (15, 3, 3), (16, 1, 4)]
for (line, pill, feed) in steps:
    move('sw-', pill, L(line) - 0.62, 0.5)
    click('sw-', pill, L(line) - 0.1)
    m = round(L(line) + 0.05, 2)
    js(f'tl.fromTo("#sw-f{feed}", {{ clipPath: "inset(0% 0% 100% 0%)", filter: "blur(12px) brightness(1.25)", scale: 1.06 }}, {{ clipPath: "inset(0% 0% 0% 0%)", filter: "blur(0px) brightness(1)", scale: 1.03, duration: 0.7, ease: "power2.inOut" }}, {m});')
    js(f'tl.fromTo("#sw-f{feed - 1}", {{ filter: "blur(0px)" }}, {{ filter: "blur(6px)", duration: 0.5, ease: "power1.in", immediateRender: false }}, {m});')
    js(f'tl.fromTo("#sw-s{feed}", {{ y: 0, opacity: 1 }}, {{ y: 784, opacity: 0.2, duration: 0.7, ease: "power2.inOut" }}, {m});')
    js(f'tl.set("#sw-s{feed}", {{ opacity: 0 }}, {round(m + 0.72, 2)});')
    fx('shimmer.wav', m, 0.5, 0.7)
    fx('impactGlass_light_002.ogg', m + 0.62, 0.45, 0.5)
    fx('card-slide-3.ogg' if line % 2 else 'card-slide-1.ogg', L(line) + 0.05, 0.5, 0.5)
    ci = line - 12
    cap(f'#sw-c{ci}', L(line), (L(line + 1) - 0.1) if line < 16 else None)
js(f'tl.fromTo("#sw-one", {{ scale: 0, rotation: -20, opacity: 0 }}, {{ scale: 1, rotation: -6, opacity: 1, duration: 0.45, ease: "back.out(2.4)" }}, {L(16, 0.7)});')
fx('chips-collide-1.ogg', L(16, 0.7), 0.55, 0.6)

# 8 · no changing rooms / screenshots / guessing
a = S['no'][0]
punch('#no-stage', a)
rows = [('#no1', L(17)), ('#no2', L(18)), ('#no3', L(19))]
for i, (sel, at) in enumerate(rows):
    js(f'tl.fromTo("{sel}", {{ x: -160, opacity: 0 }}, {{ x: 0, opacity: 1, duration: 0.38, ease: "power4.out" }}, {at});')
    js(f'tl.fromTo("{sel} .x", {{ scale: 0, rotation: -90 }}, {{ scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2.4)" }}, {round(at + 0.05, 2)});')
    fx('impactSoft_medium_004.ogg', at, 0.65)
    fx('impactPunch_medium_000.ogg', at + 0.05, 0.35)
    if i < 2:
        js(f'tl.to("{sel}", {{ opacity: 0.32, duration: 0.25 }}, {round(rows[i + 1][1] - 0.05, 2)});')

# 9 · the entire internet is your fitting room
a = S['web'][0]
js(f'tl.fromTo("#web-wall", {{ scale: 1.5 }}, {{ scale: 0.92, duration: {S["web"][1] - a:.2f}, ease: "power2.out" }}, {a});')
js(f'tl.fromTo("#web-wall .pill", {{ scale: 0.4, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.25, ease: "back.out(2.4)", stagger: {{ each: 0.035, from: "center" }}, transformOrigin: "20% 50%" }}, {round(a + 0.3, 2)});')
for k in range(12):
    fx('rollover2.ogg', a + 0.3 + k * 0.1, 0.35, 0.2)
rise('#web1', L(20, 0.15))
rise('#web2', L(20, 0.5))
fx('impactSoft_heavy_003.ogg', L(20, 0.5), 0.5)

# 10 · see it, try it, then decide
for i, n in enumerate([21, 22, 23]):
    js(f'tl.fromTo("#std{i + 1}", {{ y: 160, opacity: 0, rotation: 3 }}, {{ y: 0, opacity: 1, rotation: 0, duration: 0.4, ease: "back.out(1.4)" }}, {L(n)});')
    fx('impactWood_light_001.ogg', L(n), 0.65, 0.4)

# 11 · outro
a = S['out'][0]
js(f'tl.fromTo("#out-glow", {{ scale: 0.4, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 1.2, ease: "power2.out" }}, {a});')
js(f'tl.fromTo("#out-mark", {{ scale: 0, rotation: -30 }}, {{ scale: 1, rotation: 0, duration: 0.55, ease: "back.out(2.2)" }}, {L(24) - 0.05});')
js(f'tl.fromTo("#out-word", {{ y: 80, opacity: 0, scale: 1.12 }}, {{ y: 0, opacity: 1, scale: 1, duration: 0.55, ease: "expo.out" }}, {L(24)});')
js(f'tl.fromTo("#out-free", {{ scale: 0.5, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.4, ease: "back.out(2.2)" }}, {L(25)});')
rise('#out-line', L(26))
js(f'tl.fromTo("#out-cta", {{ y: 40, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.45, ease: "back.out(1.8)" }}, {round(L(26) + D[25] + 0.2, 2)});')
js(f'tl.fromTo("#out-url", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.4 }}, {round(L(26) + D[25] + 0.45, 2)});')
js(f'tl.set("#cta-ring", {{ opacity: 1 }}, {round(L(26) + D[25] + 0.8, 2)});')
js(f'tl.to("#cta-ring", {{ scale: 1.18, opacity: 0, duration: 0.9, ease: "power2.out", repeat: 1 }}, {round(L(26) + D[25] + 0.8, 2)});')
fx('impactBell_heavy_000.ogg', L(24) - 0.05, 0.55, 1.5)
fx('shimmer.wav', L(24) + 0.1, 0.4, 0.7)
fx('chips-collide-1.ogg', L(25), 0.55, 0.6)
fx('drop_002.ogg', L(26), 0.5, 0.4)
fx('click_003.ogg', L(26) + D[25] + 0.2, 0.6, 0.2)

for a_ in AUTO:
    fx(*a_, auto=True)

# ---- music bed: "Happy Beats / Business Moves vol. 1" (120 BPM), ducked under every voice line ----
BED, DUCK = 0.5, 0.2
js(f'tl.fromTo("#bgm", {{ volume: 0 }}, {{ volume: {BED}, duration: 0.5, ease: "none" }}, 0);')
for i in range(N):
    down = round(T[i] - 0.15, 2)
    js(f'tl.to("#bgm", {{ volume: {DUCK}, duration: 0.15, ease: "none" }}, {max(down, 0.5)});')
    nxt = T[i + 1] if i + 1 < N else END
    up = round(T[i] + D[i] + 0.05, 2)
    if nxt - up > 0.55:  # only swell back up in gaps long enough to hear it
        js(f'tl.to("#bgm", {{ volume: {BED if i + 1 < N else 0.65}, duration: 0.3, ease: "none" }}, {up});')
js(f'tl.to("#bgm", {{ volume: 0, duration: 1.4, ease: "power1.in" }}, {round(END - 1.4, 2)});')

# ---- assemble ----
X = '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
wall = ''.join(
    f'<div class="wt"><img src="assets/img/{PRODUCTS[(r * 3 + c) % 6]}.jpg" alt="" /><div class="pill" data-layout-ignore>Try On</div></div>'
    for r in range(4) for c in range(9))
vo = '\n'.join(
    f'      <audio id="vo{i + 1:02d}" src="assets/vo/l{i + 1:02d}.wav" data-start="{T[i]:.2f}" data-duration="{D[i]:.2f}" data-track-index="3" data-volume="1"></audio>'
    for i in range(N))
FX.sort(key=lambda f: f[1])
fxs = f'      <audio id="bgm" src="assets/music/bgm.mp3" data-start="0" data-duration="{END:.2f}" data-track-index="10" data-volume="1"></audio>\n' + '\n'.join(
    f'      <audio id="fx{k:02d}" src="assets/sfx/{f}" data-start="{at:.2f}" data-duration="{ln}" data-track-index="{11 + k}" data-volume="{vol}"></audio>'
    for k, (f, at, vol, ln) in enumerate(FX))

html = open('template.html').read()
for key, val in {
    '{{END}}': f'{END:.2f}',
    '{{VO}}': vo, '{{FX}}': fxs, '{{JS}}': '\n      '.join(JS), '{{WALL}}': wall, '{{X}}': X,
    '{{STORE_FIND}}': store('fi-', ['p-pink'], ['Find something you like.', 'Hit <span class="hl">Try On.</span>', 'And see it <span class="hl">on you.</span>']),
    '{{STORE_SWAP}}': store('sw-', ['p-pink', 'p-coral', 'p-leopard', 'p-cocaine', 'p-blue'],
                            ["Don't like it?", '<span class="hl">Swap it.</span>', 'Try another.', 'And another.', 'Until you find <span class="hl">the one.</span>']),
    **{'{{CLIP_%s}}' % k.upper(): clip(k) for k in S},
}.items():
    html = html.replace(key, val)
open('composition/index.html', 'w').write(html)
print(f'duration {END}s · {len(FX)} sfx · lines at', json.dumps(T))
