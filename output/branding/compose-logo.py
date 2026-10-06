"""Assemble a new vector logo from original editable SVG components."""
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2]
ET.register_namespace('', 'http://www.w3.org/2000/svg')
brand = ET.parse(root / 'output/branding/vnpay-official.svg').getroot()
db = ET.parse(root / 'output/branding/tabledb-original.svg').getroot()
serialize = lambda el: ET.tostring(el, encoding='unicode')
paths = brand.findall('{http://www.w3.org/2000/svg}path')
brand_defs = serialize(brand.find('{http://www.w3.org/2000/svg}defs'))
db_defs = serialize(db.find('{http://www.w3.org/2000/svg}defs'))
emblem = ''.join(serialize(p) for p in paths[:9])
wordmark = ''.join(serialize(p) for p in paths[9:11])
db_symbol = ''.join(serialize(el) for el in list(db)[1:5])
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" role="img" aria-labelledby="title">
<title id="title">VNPAY TableDB</title>
{brand_defs}
{db_defs}
<defs><filter id="brand-outline" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
<feMorphology in="SourceAlpha" operator="dilate" radius="1.8" result="expanded"/>
<feFlood flood-color="white" result="white"/><feComposite in="white" in2="expanded" operator="in" result="outline"/>
<feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter></defs>
<rect x="48" y="48" width="928" height="928" rx="180" fill="white"/>
<svg x="150" y="160" width="724" height="164" viewBox="57.15 11.79 81.21 18.21">{wordmark}</svg>
<g transform="translate(198 342) scale(.62)">{db_symbol}</g>
<svg x="641" y="708" width="246" height="196" viewBox="-3 -3 60 48"><g filter="url(#brand-outline)">{emblem}</g></svg>
</svg>'''
(root / 'output/branding/tabledb-vnpay-v2.svg').write_text(svg)
