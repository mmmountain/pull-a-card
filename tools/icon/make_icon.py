# Prompter icon: four coloured cards on slate, the sunflower top card lifting off with a white spark.
# Renders assets/icon.png, android-icon-{background,foreground,monochrome}.png, splash-icon.png (needs rsvg-convert).
import subprocess
S=160; W,H=88,100; step=(-5,6); lift=(9,-11); rot=10; DX,DY=-43.9137,-51.1682
BG="#363d4a"; TOP="#ffc928"; SPARK="#ffffff"; STACK=["#6b3fd4","#ff6b5a","#2f8fe0","#5fd3b0"]
def art(sc, mono=False):
    f=lambda c: "#ffffff" if mono else c
    cards="".join(f'<rect x="{(3-i)*step[0]}" y="{(3-i)*step[1]}" width="{W}" height="{H}" rx="11" fill="{f(c)}"/>' for i,c in enumerate(STACK))
    tx,ty=lift; cx,cy=tx+W/2,ty+H/2
    sp=f'<path d="M{cx} {cy-22} Q{cx+3} {cy-3} {cx+22} {cy} Q{cx+3} {cy+3} {cx} {cy+22} Q{cx-3} {cy+3} {cx-22} {cy} Q{cx-3} {cy-3} {cx} {cy-22} Z" fill="{"#000000" if mono else SPARK}"/>'
    # mono: top card cut out from the stack with a gap, spark punched through, so it reads as one silhouette
    top=f'<rect x="{tx}" y="{ty}" width="{W}" height="{H}" rx="11" fill="{f(TOP)}"/>'
    gap=f'<rect x="{tx-3}" y="{ty-3}" width="{W+6}" height="{H+6}" rx="13" fill="#000000"/>' if mono else ""
    t=f'<g transform="rotate({rot} {cx} {cy})">{gap}{top}{sp}</g>'
    return f'<g transform="translate({S/2} {S/2}) scale({sc}) translate({DX} {DY})">{cards}{t}</g>'
def out(name, body, size=1024, mask=False):
    m = '<mask id="m"><rect width="160" height="160" fill="#fff"/>'+body.replace('#ffffff','#fff')+'</mask>' if False else ''
    open('o.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {S} {S}">{body}</svg>')
    subprocess.run(['rsvg-convert','o.svg','-o',name],check=True)
out('icon.png', f'<rect width="160" height="160" fill="{BG}"/>{art(0.84)}')                 # full-bleed square: launchers round it
out('android-icon-background.png', f'<rect width="160" height="160" fill="{BG}"/>')
out('android-icon-foreground.png', art(0.47))                                                     # inside Android's safe circle
out('splash-icon.png', art(0.84), 512)
# monochrome (themed icons): white silhouette, transparent gaps
open('mono.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 160 160"><defs><mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="160"><rect width="160" height="160" fill="#000"/>{art(0.47, mono=True)}</mask></defs><rect width="160" height="160" fill="#ffffff" mask="url(#k)"/></svg>')
subprocess.run(['rsvg-convert','mono.svg','-o','android-icon-monochrome.png'],check=True)
