#!/usr/bin/env python3
"""Build the GNOME extension ZIP from the source tree."""
import os
import shutil
import zipfile

ext_dir = '/tmp/ext-build'
src_dir = '/app/gnome-ext'
out_zip = '/app/tests/gnome-references/voice-to-text@happytomatoe.com.shell-extension.zip'

os.makedirs(os.path.dirname(out_zip), exist_ok=True)
os.makedirs(f'{ext_dir}/schemas', exist_ok=True)

# Copy extension files
for f in os.listdir(src_dir):
    if f.endswith(('.js', '.json', '.css')):
        shutil.copy(os.path.join(src_dir, f), ext_dir)

for f in os.listdir(os.path.join(src_dir, 'schemas')):
    shutil.copy(os.path.join(src_dir, 'schemas', f), f'{ext_dir}/schemas')

# Compile schemas
os.system(f'glib-compile-schemas {ext_dir}/schemas')

# Create ZIP
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(ext_dir):
        for file in files:
            path = os.path.join(root, file)
            arcname = os.path.relpath(path, ext_dir)
            zf.write(path, arcname)

shutil.rmtree(ext_dir)
print(f'Extension ZIP created: {out_zip}')
