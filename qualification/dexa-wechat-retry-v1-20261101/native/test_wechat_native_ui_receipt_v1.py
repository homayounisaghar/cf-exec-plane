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
 def test_multiple_evicted_old_rows_and_red_failure_classification(self):
  old=['Video 0:02','Video 0:03','Unable to send Video 0:10']
  new=['Unable to send Video 0:10','Video 0:23']
  self.assertTrue(v.fresh_video_row(old,new,'owner.mp4',sep))
  self.assertFalse(v.fresh_failed_video_row(old,new,'owner.mp4',sep))
  failed=['Unable to send Video 0:10','Unable to send Video 0:23']
  self.assertTrue(v.fresh_failed_video_row(old,failed,'owner.mp4',sep))
  self.assertFalse(v.fresh_video_row(old,failed,'owner.mp4',sep))
  self.assertFalse(v.fresh_video_row(old,['Video 0:23'],'owner.mp4',sep))
  self.assertFalse(v.fresh_failed_video_row(old,['Unable to send Video 0:23'],'owner.mp4',sep))
  self.assertFalse(v.fresh_failed_video_row(old,old,'owner.mp4',sep))
  self.assertFalse(v.fresh_failed_video_row(old,['Video 0:03','Unable to send Video 0:10'],'owner.mp4',sep))
  self.assertFalse(v.fresh_video_row(old,['Video 0:03','Video 0:23','other'],'owner.mp4',sep))

 def test_only_newly_failed_tail_can_be_recovered(self):
  failed=['Video 0:03','Unable to send Video 0:10']
  self.assertTrue(v.resend_cleared_video_row(failed,['Video 0:03','Video 0:10'],'owner.mp4',sep))
  self.assertTrue(v.resend_cleared_video_row(['Video 0:02',*failed],['Video 0:03','Video 0:10'],'owner.mp4',sep))
  for after in (failed,['Video 0:03','Unable to send Video 0:10','Video 0:10'],
                ['Video 0:03','Video 0:11'],['Unrelated','Video 0:10']):
   self.assertFalse(v.resend_cleared_video_row(failed,after,'owner.mp4',sep))
  self.assertFalse(v.resend_cleared_video_row(['Video 0:10'],['Video 0:10'],'owner.mp4',sep))

 def test_isolated_native_red_icon_requires_unique_circle_not_video_red(self):
  class FakeImage:
   width,height=1000,450
   def __init__(self):self.red=set()
   def getpixel(self,p):return (249,92,96) if p in self.red else (255,255,255)
   def circle(self,cx,cy):
    for dx in range(-8,9):
     for dy in range(-8,9):
      if 26<=dx*dx+dy*dy<=64:self.red.add((cx+dx,cy+dy))
  class Mapper:
   def box(self,rect,viewport):return (130,100,950,400)
  class Row:rect=object()
  image=FakeImage();image.circle(610,185)
  self.assertEqual(v.red_failure_icon_pixel(image,Mapper(),Row(),None),(610,185))
  image.circle(690,200)
  self.assertIsNone(v.red_failure_icon_pixel(image,Mapper(),Row(),None))
  other=FakeImage()
  for x in range(520,575):
   for y in range(140,225):other.red.add((x,y))
  self.assertIsNone(v.red_failure_icon_pixel(other,Mapper(),Row(),None))

 def test_single_durable_resend_claim_and_recovery_witness(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);root.chmod(0o700)
   target='File Transfer';upload='c'*64;digest='d'*64
   key=v.receipt_key(target,upload,digest)
   attempt=root/(key+'.attempt')
   attempt.write_text('ATTEMPTED_NO_RETRY\n');attempt.chmod(0o600)
   with self.assertRaises(FileNotFoundError):
    v.record_verified_ui(target,upload,digest,'video.mp4',31,1,'failed_video_resend_once',root)
   self.assertEqual(v.claim_one_ui_resend(target,upload,digest,root),key)
   with self.assertRaises(FileExistsError):
    v.claim_one_ui_resend(target,upload,digest,root)
   marker=root/(key+'.resend')
   self.assertEqual(marker.read_text(),'EXPLICIT_UI_FAILED_ROW_RETRY_ONCE\n')
   self.assertEqual(stat.S_IMODE(marker.stat().st_mode),0o600)
   v.record_verified_ui(target,upload,digest,'video.mp4',31,1,'failed_video_resend_once',root)
   proof=json.loads((root/(key+'.observed.json')).read_text())
   self.assertEqual(proof['row_evidence'],'failed_video_resend_once')
   self.assertEqual(proof['resend_confirm_clicks'],1)
   self.assertEqual(proof['provider_confirmed'],False)

if __name__=='__main__':unittest.main()
