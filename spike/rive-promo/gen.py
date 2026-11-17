#!/usr/bin/env python3
"""Generate scene.rml: the C-Store promo rebuilt in Rive, matching the HTML spike's "rich" variant.

Artboard is 1920x1080. Lengths mirror the CSS (1vmin = 10.8 px). Run: python3 gen.py
"""
import math
import os
import pathlib

W, H, U = 1920, 1080, 10.8
_id = [100]


def nid():
    _id[0] += 1
    return f"0:{_id[0]}"


FONT = "0:30"
WGHT = 2003265652  # 'wght'
EASE = {
    "out": (0.2, 0.8, 0.2, 1),
    "pop": (0.2, 1.4, 0.3, 1),
    "rise": (0.2, 1.2, 0.3, 1),
    "inout": (0.42, 0, 0.58, 1),
}


def fill(color, feather=None):
    if feather and os.environ.get("NOFEATHER"):
        return ""  # diagnostic build: no blurred shadows
    if feather:
        strength, oy = feather
        return (f'<Fill fillRule="clockwise" name="Shadow"><SolidColor colorValue="{color}" name="C"/>'
                f'<Feather strength="{strength}" offsetY="{oy}" name="F"/></Fill>')
    return f'<Fill name="Fill"><SolidColor colorValue="{color}" name="C"/></Fill>'


def rect(x, y, w, h, r=0):
    """Rectangle given by its top-left corner in the parent shape's space."""
    return (f'<Rectangle x="{x + w / 2:.2f}" y="{y + h / 2:.2f}" width="{w}" height="{h}" '
            f'cornerRadiusTL="{r}" name="P"/>')


def text(x, y, runs, name, ox=0.0, oy=0.0, ident=None, opacity=1):
    """runs: list of (string, size, weight, colour)."""
    styles, values = [], []
    for s, size, weight, color in runs:
        sid = nid()
        styles.append(
            f'<TextStylePaint fontSize="{size}" fontAssetId="{FONT}" name="S" id="{sid}">{fill(color)}'
            f'<TextStyleAxis tag="{WGHT}" axisValue="{weight}" name="Weight"/></TextStylePaint>')
        values.append(f'<TextValueRun styleId="{sid}" text="{s}" name="Run"/>')
    idattr = f' id="{ident}"' if ident else ""
    return (f'<Text x="{x}" y="{y}" opacity="{opacity}" sizingValue="autoWidth" wrapValue="noWrap" originX="{ox}" originY="{oy}" '
            f'name="{name}"{idattr}>' + "".join(styles) + "".join(values) + "</Text>")


class Anim:
    def __init__(self, name, duration, loop="loop"):
        self.id, self.name, self.duration, self.loop = nid(), name, duration, loop
        self.objects = {}

    def key(self, obj, prop, keys):
        """keys: list of (frame, value, ease-name or 'linear')."""
        self.objects.setdefault(obj, []).append((prop, keys))

    def xml(self):
        out = [f'<LinearAnimation loopValue="{self.loop}" duration="{self.duration}" name="{self.name}" id="{self.id}">']
        for obj, props in self.objects.items():
            out.append(f'<KeyedObject objectId="{obj}">')
            for prop, keys in props:
                out.append(f'<KeyedProperty property="{prop}">')
                for frame, value, ease in keys:
                    if ease == "linear":
                        out.append(f'<KeyFrameDouble value="{value:.5f}" frame="{int(round(frame))}" interpolationType="linear"/>')
                    else:
                        x1, y1, x2, y2 = EASE[ease]
                        out.append(f'<KeyFrameDouble value="{value:.5f}" frame="{int(round(frame))}" interpolationType="cubic">'
                                   f'<CubicEaseInterpolator x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/></KeyFrameDouble>')
                out.append("</KeyedProperty>")
            out.append("</KeyedObject>")
        out.append("</LinearAnimation>")
        return "".join(out)


main = Anim("Cycle", 480)
bob = Anim("Bob", 192, "pingPong")
spin = Anim("Spin", 840)


def inout(obj, prop, delay, start, hold, end, ease, in_len=58, out_at=422, out_end=461):
    """The CSS cycle: animate in after a delay, hold, animate out before the loop point."""
    f0 = delay * 60
    keys = [(0, start, "linear")] if f0 > 0 else []
    keys += [(f0, start, ease), (f0 + in_len, hold, "linear"), (out_at, hold, "out"), (out_end, end, "linear"),
             (480, end, "linear")]
    main.key(obj, prop, keys)


front = []  # first declared draws on top

# Wipe
wipe = nid()
front.append(f'<Shape opacity="1" name="Wipe" id="{wipe}">{rect(0, 0, W, H)}{fill("FF06122B")}</Shape>')
main.key(wipe, "opacity", [(0, 1, "linear"), (24, 0, "linear"), (456, 0, "linear"), (480, 1, "linear")])

# Legal line
legal = nid()
front.append(text(86, 1025, [("Limited time offer. See store for details.", 17, 400, "FFFFFFFF")], "Legal", ident=legal, opacity=0))
main.key(legal, "opacity", [(0, 0, "linear"), (48, 0, "linear"), (86, 0.7, "linear"), (422, 0.7, "linear"), (461, 0, "linear"), (480, 0, "linear")])

# Points badge
badge, ring = nid(), nid()
bx, by = 1678, 222
front.append(
    f'<Node x="{bx}" y="{by}" name="Badge" id="{badge}">'
    + text(0, -62, [("Up to", 26, 700, "FF06122B")], "Up to", ox=0.5, oy=0.5)
    + text(0, 0, [("400", 97, 900, "FFC8102E")], "Points value", ox=0.5, oy=0.5)
    + text(0, 62, [("Points", 26, 700, "FF06122B")], "Points", ox=0.5, oy=0.5)
    + f'<Shape name="Ring" id="{ring}"><Ellipse width="274" height="274" name="P"/>'
      f'<Stroke thickness="8.8" name="S"><SolidColor colorValue="FFC8102E" name="C"/>'
      f'<DashPath name="D"><Dash length="17.5" name="On"/><Dash length="14.6" name="Off"/></DashPath></Stroke></Shape>'
    + f'<Shape name="Disc"><Ellipse width="257" height="257" name="P"/>{fill("80000000", (30, 16))}{fill("FFFFFFFF")}</Shape>'
    + "</Node>")
for p in ("scaleX", "scaleY"):
    inout(badge, p, 0.9, 0, 1, 0.6, "pop")
inout(badge, "rotation", 0.9, -0.698, 0, 0, "pop")
inout(badge, "opacity", 0.9, 0, 1, 0, "out")
spin.key(ring, "rotation", [(0, 0, "linear"), (840, 2 * math.pi, "linear")])

# Copy block
top = 266
price = nid()
front.append(
    f'<Node x="86" y="{top + 180}" name="Price" id="{price}">'
    + text(0, -262, [("2", 367, 900, "FFFFFFFF"), ("/", 367, 300, "B3FFFFFF"), ("$", 154, 900, "FFFFFFFF"), ("4", 367, 900, "FFFFFFFF")], "Price text")
    + "</Node>")
for p in ("scaleX", "scaleY"):
    inout(price, p, 0, 0.3, 1, 0.9, "pop")
inout(price, "opacity", 0, 0, 1, 0, "out")
for i, (label, y, size, weight, color, delay) in enumerate([
        ("BUY ANY 2", top + 333, 56, 800, "FFFFD84A", 0.25),
        ("SPORT DRINKS", top + 400, 91, 800, "FFFFFFFF", 0.4),
        ("All flavours, 710 mL", top + 509, 32, 500, "D9FFFFFF", 0.55)]):
    t = nid()
    front.append(text(86, y, [(label, size, weight, color)], f"Line {i + 1}", ident=t, opacity=0))
    inout(t, "x", delay, 86 - 576, 86, 86 - 154, "out")
    inout(t, "opacity", delay, 0, 1, 0, "out")

# Panel behind the copy
front.append(
    f'<Shape name="Panel">{rect(108, top - 43, 797, 548 + 86, 43)}'
    f'<Stroke thickness="1.6" name="S"><SolidColor colorValue="2EFFFFFF" name="C"/></Stroke>'
    f'<Fill name="Fill"><LinearGradient startX="108" startY="{top - 43}" endX="905" endY="{top + 591}" name="G">'
    f'<GradientStop colorValue="29FFFFFF" position="0"/><GradientStop colorValue="0AFFFFFF" position="1"/></LinearGradient></Fill></Shape>')


def bottle(left_pct, height_pct, color, delay):
    h = H * height_pct
    scale = h / 280
    cx = 883 + 1037 * left_pct + (h / 2.8) / 2
    cy = 983 - h / 2
    outer, inner = nid(), nid()
    parts = [
        f'<Shape name="Stripe">{rect(-24, -6, 48, 9, 2)}{fill(color)}</Shape>',
        f'<Shape name="Text 1">{rect(-24, 10, 34, 5, 2)}{fill("FF333333")}</Shape>',
        f'<Shape name="Text 2">{rect(-24, 21, 42, 5, 2)}{fill("FF333333")}</Shape>',
        f'<Shape name="Label">{rect(-32, -20, 64, 74)}{fill("EBFFFFFF")}</Shape>',
        f'<Shape name="Shine">{rect(-24, -70, 14, 190, 7)}{fill("47FFFFFF")}</Shape>',
        f'<Shape name="Cap">{rect(-14, -138, 28, 22, 5)}{fill("FF111111")}</Shape>',
        f'<Shape name="Body">{rect(-32, -80, 64, 216, 20)}{rect(-12, -116, 24, 60)}'
        f'{fill("8C000000", (30, 22))}{fill(color)}</Shape>',
    ]
    xml = (f'<Node x="{cx:.1f}" y="{cy:.1f}" opacity="0" name="Bottle" id="{outer}">'
           f'<Node scaleX="{scale:.4f}" scaleY="{scale:.4f}" name="Bob" id="{inner}">' + "".join(parts) + "</Node></Node>")
    inout(outer, "y", delay, cy + 1.1 * h, cy, cy + 0.3 * h, "rise", in_len=67, out_end=466)
    inout(outer, "rotation", delay, 0.14, 0, 0, "rise", in_len=67, out_end=466)
    inout(outer, "opacity", delay, 0, 1, 0, "out", in_len=67, out_end=466)
    bob.key(inner, "y", [(0, -0.012 * h, "inout"), (192, 0.012 * h, "linear")])
    bob.key(inner, "rotation", [(0, -0.021, "inout"), (192, 0.021, "linear")])
    return xml


b1 = bottle(0.14, 0.70, "FF19A7FF", 0.5)
b2 = bottle(0.36, 0.80, "FF27C46B", 0.35)
b3 = bottle(0.60, 0.70, "FFFF3B4E", 0.65)
front += [b2, b1, b3]

# Glow
glow = nid()
front.append(
    f'<Shape x="1396" y="540" name="Glow" id="{glow}"><Ellipse width="972" height="972" name="P"/>'
    f'<Fill name="Fill"><RadialGradient startX="0" startY="0" endX="486" endY="0" name="G">'
    f'<GradientStop colorValue="8C78BEFF" position="0"/><GradientStop colorValue="0078BEFF" position="0.65"/>'
    f'<GradientStop colorValue="0078BEFF" position="1"/></RadialGradient></Fill></Shape>')
for p in ("scaleX", "scaleY"):
    main.key(glow, p, [(0, 0.85, "inout"), (240, 1.1, "inout"), (480, 0.85, "linear")])
main.key(glow, "opacity", [(0, 0.6, "inout"), (240, 1, "inout"), (480, 0.6, "linear")])

# Background
front.append(
    f'<Shape name="Background">{rect(0, 0, W, H)}'
    f'<Fill name="Fill"><RadialGradient startX="1344" startY="432" endX="3000" endY="432" name="G">'
    f'<GradientStop colorValue="FF1C4FD6" position="0"/><GradientStop colorValue="FF0B2A7A" position="0.45"/>'
    f'<GradientStop colorValue="FF06122B" position="1"/></RadialGradient></Fill></Shape>')

layers = []
for a in (main, bob, spin):
    state = nid()
    layers.append(
        f'<StateMachineLayer name="{a.name}" id="{nid()}"><EntryState><StateTransition stateToId="{state}"/></EntryState>'
        f'<AnimationState animationId="{a.id}" id="{state}"/></StateMachineLayer>')

doc = (
    '<Rive version="1" kind="fragment">'
    f'<Artboard defaultStateMachineId="0:7" styleId="0:5" width="{W}" height="{H}" name="Promo" id="0:2">'
    '<LayoutComponentStyle name="Artboard Style" id="0:5"/>'
    '<Fill name="Background"><SolidColor colorValue="FF06122B" name="Color"/></Fill>'
    + "".join(front)
    + '<StateMachine name="Play" id="0:7">' + "".join(layers) + "</StateMachine>"
    + main.xml() + bob.xml() + spin.xml()
    + "</Artboard>"
    f'<FontAsset file="Inter.ttf" name="Inter" id="{FONT}"/>'
    "</Rive>\n")
pathlib.Path(__file__).with_name("scene.rml").write_text(doc)
print("wrote scene.rml", len(doc), "bytes")
