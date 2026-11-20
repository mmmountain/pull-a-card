import subprocess
# One tilted card with the spark cut out, centred: the status-bar notification icon and the themed (monochrome) icon.
W,H,rot=88,100,10
def svg(size, card_frac):
    S=160; k=card_frac*S/ (H*1.05)       # scale so the rotated card's height is card_frac of the canvas
    cx=cy=S/2; q=1.4*k
    sp=lambda: f"M{cx} {cy-22*q} Q{cx+3*q} {cy-3*q} {cx+22*q} {cy} Q{cx+3*q} {cy+3*q} {cx} {cy+22*q} Q{cx-3*q} {cy+3*q} {cx-22*q} {cy} Q{cx-3*q} {cy-3*q} {cx} {cy-22*q} Z"
    card=f'<rect x="{cx-W*k/2}" y="{cy-H*k/2}" width="{W*k}" height="{H*k}" rx="{11*k}" fill="#fff"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {S} {S}"><defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="160"><rect width="160" height="160" fill="#000"/><g transform="rotate({rot} {cx} {cy})">{card}<path d="{sp()}" fill="#000"/></g></mask></defs><rect width="160" height="160" fill="#ffffff" mask="url(#m)"/></svg>'
for name,size,frac in [("notification-icon.png",96,0.8),("android-icon-monochrome.png",1024,0.5)]:
    open('n.svg','w').write(svg(size,frac)); subprocess.run(['rsvg-convert','n.svg','-o',name],check=True)
