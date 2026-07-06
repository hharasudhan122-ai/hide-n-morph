from pathlib import Path
import json, struct, sys
p = Path('public/maps/freefire-map/scene.glb')
if not p.exists():
    print('MISSING', p)
    sys.exit(2)
data = p.read_bytes()
# GLB header
magic = data[0:4]
if magic != b'glTF':
    print('not glb')
    sys.exit(1)
# chunk header at offset 12
off = 12
json_len, json_type = struct.unpack_from('<I4s', data, off)
off += 8
json_chunk = data[off:off+json_len]
js = json.loads(json_chunk.decode('utf8'))
accessors = js.get('accessors', [])
minx = miny = minz = 1e9
maxx = maxy = maxz = -1e9
found = False
for a in accessors:
    mn = a.get('min')
    mx = a.get('max')
    if mn and mx and len(mn) >= 3:
        found = True
        minx = min(minx, mn[0]); miny = min(miny, mn[1]); minz = min(minz, mn[2])
        maxx = max(maxx, mx[0]); maxy = max(maxy, mx[1]); maxz = max(maxz, mx[2])
if not found:
    print('NO_ACCESSOR_MINMAX')
else:
    print('MIN', minx, miny, minz)
    print('MAX', maxx, maxy, maxz)
    # output JSON for downstream parsing
    print(json.dumps({'min':[minx,miny,minz],'max':[maxx,maxy,maxz]}))
