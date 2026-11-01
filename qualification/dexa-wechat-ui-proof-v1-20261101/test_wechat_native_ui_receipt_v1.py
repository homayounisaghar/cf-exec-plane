import json,os,stat,sys, tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import wechat_native_ui_receipt_v1 as v

def sep(x):
 return x in ('10:01','Yesterday','09:45','11:32','')
class NativeVideoUITest(unittest.TestCase):
 def test_unique_fresh_video_and_existing_same_duration(self):
  b=['10:01','Video 0:23']
  a=['10:01','Video 0:23','Video 0:23']
  self.assertTrue(v.fresh_video_row(b,a,'owner.mp4',sep))
  self.assertTrue(v.fresh_video_row(['0:23','Video 0:23'],['Video 0:23','Video 0:23'],'owner.mp4',sep))
 def test_no_new_row_or_wrong_media(self):
  baseline=['Video 0:23']
  self.assertFalse(v.fresh_video_row(baseline,baseline,'video.mp4',sep))
  self.assertFalse(v.fresh_video_row([],['Video 0:23'],'photo.png',sep))
  self.assertFalse(v.fresh_video_row([],['Unrelated file.txt'],'video.mp4',sep))
  self.assertFalse(v.fresh_video_row([],['Video 0:23','Video 0:23'],'video.mp4',sep))
  self.assertFalse(v.fresh_video_row([],['Video 0:23'],'animation.gif',sep))
  self.assertFalse(v.fresh_video_row(['Video 0:23','some'],['some','Video 0:23','other'],'video.mp4',sep))
  self.assertFalse(v.fresh_video_row([],['Video 0:23'],'video.mp4.exe',sep))
 def test_marker_atomic_immutable_secure_and_identical(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp)
   os.chmod(d,0o700)
   target='File Transfer';upload='a'*64;digest='f'*64
   key=v.receipt_key(target,upload,digest)
   attempt=d/(key+'.attempt')
   attempt.write_text('ATTEMPTED_NO_RETRY\n')
   os.chmod(attempt,0o600)
   out=v.record_verified_ui(target,upload,digest,'file.mp4',4057059,1,'unique_video_row',d)
   self.assertEqual(out,key)
   file=d/(key+'.observed.json')
   j=json.loads(file.read_text())
   self.assertEqual(j['schema'],v.SCHEMA)
   self.assertEqual(j['target'],target)
   self.assertEqual(j['sha256_hex'],digest)
   self.assertTrue(j['observed_at_ns']>=j['attempt_mtime_ns'])
   self.assertEqual(j['send_clicks'],1)
   self.assertEqual(j['verification_source'],'native_same_client_atspi_x11')
   self.assertEqual(stat.S_IMODE(file.stat().st_mode),0o600)
   with self.assertRaises(FileExistsError):
    v.record_verified_ui(target,upload,digest,'file.mp4',4057059,1,'unique_video_row',d)
   self.assertEqual(json.loads(file.read_text()),j)
 def test_no_proof_before_one_clicked_send(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp);os.chmod(d,0o700)
   for clicks in (0,2):
    with self.assertRaises(ValueError):
     v.record_verified_ui('File Transfer','a'*64,'b'*64,'file.mp4',20,clicks,'unique_video_row',d)
   self.assertEqual(list(d.glob('*')) ,[])
 def test_no_proof_for_unsafe_directory_or_missing_marker(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp);os.chmod(d,0o700)
   with self.assertRaises(FileNotFoundError):
    v.record_verified_ui('File Transfer','a'*64,'b'*64,'file.mp4',20,1,'unique_video_row',d)
   os.chmod(d,0o755)
   with self.assertRaises(ValueError):
    v.record_verified_ui('File Transfer','a'*64,'b'*64,'file.mp4',20,1,'unique_video_row',d)
if __name__=='__main__':unittest.main()
