import fcntl,hashlib,json,os,pathlib,shutil,sys
base,stage=map(pathlib.Path,sys.argv[1:3])
version=sys.argv[3]
if stage.resolve().parent!=base.resolve() or not stage.name.startswith('.incoming-'):
 raise RuntimeError('The staging folder must be inside the feed storage')
with (base/'.publish.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 m=json.loads((stage/'bogen-macos-release.json').read_text())
 if m['version']!=version: raise RuntimeError('Staged version differs')
 assets=base/'assets'; assets.mkdir(exist_ok=True)
 for arch,b in m['builds'].items():
  if arch not in ('arm64','x64') or b['file']!=f'Bogen-{version}-{arch}.zip': raise RuntimeError('Invalid build path')
  p=stage/b['file']
  digest=hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
  if p.stat().st_size!=b['size'] or digest!=b['sha256']: raise RuntimeError('Staged ZIP differs from manifest')
  target=assets/b['file']
  if target.exists():
   if target.is_symlink() or hashlib.file_digest(target.open('rb'),'sha256').hexdigest()!=digest: raise RuntimeError('Refusing to replace an existing versioned ZIP')
  else:
   p.chmod(0o644); os.rename(p,target)
 destination=base/'manifests'/version
 if destination.exists():
  for name in ('bogen-macos-release.json','bogen-macos-release.json.sig'):
   if (destination/name).read_bytes()!=(stage/name).read_bytes(): raise RuntimeError('Refusing to replace an existing manifest version')
 else:
  destination.parent.mkdir(parents=True,exist_ok=True)
  metadata=stage/'metadata'; metadata.mkdir()
  for name in ('bogen-macos-release.json','bogen-macos-release.json.sig'):
   p=stage/name; p.chmod(0o644); os.rename(p,metadata/name)
  (metadata/'health.json').write_text(json.dumps({'schema':1,'product':'bogen-macos','state':'signed-release','otaReady':True,'version':version})+'\n')
  os.rename(metadata,destination)
 pending=base/(stage.name+'.current')
 pending.symlink_to('manifests/'+version); os.replace(pending,base/'current')
 shutil.rmtree(stage)
 print('Activated signed OTA release '+version+'; previous manifests and ZIPs retained.')
