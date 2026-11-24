"""export_onnx.py [small0|final0 ...] [--out web/models]

Turns Beat This! checkpoints into ONNX files the website can run in the browser, plus the mel filterbank the browser's
log-mel needs (so the site does not depend on anyone else's hosting).

  small0  ~8 MB   used by the website (Cloudflare Pages allows 25 MB per file)
  final0  ~80 MB  the full model; too big for Pages, fine for local use

Run it with the Python that has beat_this, torch, onnx and onnxscript installed (see README, "Rebuilding the model").
The time axis is dynamic, so a short song is fed as one short window, as beat_this/inference.py does."""
import argparse, json, pathlib, numpy as np, torch
from beat_this.inference import load_model
from beat_this.preprocessing import LogMelSpect

ap = argparse.ArgumentParser()
ap.add_argument('names', nargs='*', default=['small0'])
ap.add_argument('--out', default=str(pathlib.Path(__file__).resolve().parent.parent / 'web' / 'models'))
a = ap.parse_args()
out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)


class Wrap(torch.nn.Module):
    """[1, T, 128] log-mel  ->  beat and downbeat logits, each [1, T]."""
    def __init__(self, m):
        super().__init__(); self.m = m
    def forward(self, spect):
        y = self.m(spect)
        return y['beat'], y['downbeat']


for name in a.names:
    model = Wrap(load_model(name, 'cpu')).eval()
    x = torch.randn(1, 1500, 128)
    path = out / f'beat_this_{name}.onnx'
    # the classic TorchScript exporter: the newer dynamo one fails on this model (torch 2.15)
    torch.onnx.export(model, (x,), str(path), input_names=['spect'], output_names=['beat', 'downbeat'],
                      dynamic_axes={'spect': {1: 'T'}, 'beat': {1: 'T'}, 'downbeat': {1: 'T'}}, dynamo=False,
                      opset_version=17)
    # check the export against PyTorch on a random window and on a short one
    import onnxruntime as ort
    s = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
    for T in (1500, 400):
        x = torch.randn(1, T, 128) * 2 + 3
        with torch.no_grad(): ref = model(x)
        got = s.run(None, {'spect': x.numpy()})
        err = max(float(np.abs(got[i] - ref[i].numpy()).max()) for i in (0, 1))
        print(f'{name}: T={T} max |onnx - torch| = {err:.2e}')
        assert err < 1e-2, 'export does not match PyTorch'
    print(f'wrote {path} ({path.stat().st_size / 1e6:.1f} MB)')

# the mel filterbank, [513 fft bins x 128 mels], float32, row = fft bin (what web/js/beatthis.js reads)
fb = LogMelSpect().spect_class.mel_scale.fb.numpy().astype('<f4')
assert fb.shape == (513, 128), fb.shape
(out / 'mel_filterbank.bin').write_bytes(fb.tobytes())
print(f'wrote {out / "mel_filterbank.bin"}')
