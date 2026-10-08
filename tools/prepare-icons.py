"""Generate Relay's original connected-rings application mark, opaque at every size."""
import json
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
scale = 3
im = Image.new('RGB', (1024 * scale, 1024 * scale), '#000000')
draw = ImageDraw.Draw(im)
def box(values): return tuple(int(v * scale) for v in values)
# Thin silver frame and two linked audio endpoints: visual family, separate identity.
draw.rounded_rectangle(box((100, 100, 924, 924)), radius=110*scale, outline='#354049', width=3*scale)
draw.arc(box((220, 330, 610, 720)), 45, 315, fill='#b3c0c4', width=24*scale)
draw.arc(box((414, 330, 804, 720)), 225, 495, fill='#eceef0', width=24*scale)
draw.line(box((440, 525, 584, 525)), fill='#4fc39b', width=20*scale)
im = im.resize((1024, 1024), Image.Resampling.LANCZOS)
(root/'assets').mkdir(exist_ok=True)
im.save(root/'assets/icon.png')
im.save(root/'assets/Relay.icns', format='ICNS')
iconset = root/'assets/Relay.iconset';iconset.mkdir(exist_ok=True)
for size in (16,32,128,256,512):
    for multiple in (1,2): im.resize((size*multiple,size*multiple),Image.Resampling.LANCZOS).save(iconset/f'icon_{size}x{size}{"@2x" if multiple==2 else ""}.png')
im.save(root/'assets/icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
catalog=root/'apple/RelayAudio/Assets.xcassets'
appicon=catalog/'AppIcon.appiconset';appicon.mkdir(parents=True,exist_ok=True)
im.save(appicon/'AppIcon.png')
(catalog/'Contents.json').write_text(json.dumps({'info':{'author':'xcode','version':1}},indent=2))
(appicon/'Contents.json').write_text(json.dumps({'images':[{'filename':'AppIcon.png','idiom':'universal','platform':'ios','size':'1024x1024'}],'info':{'author':'xcode','version':1}},indent=2))
print('Generated opaque 1024px App Store icon, desktop iconset and Windows icon.')
