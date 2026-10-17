package dev.capabilityfabric.personalagent;
public final class CommandExtractorSelfTest {
 private static void expect(String expected,String chunk,String... aliases){
   String observed=WakeCommandExtractor.inlineCommand(chunk,aliases);
   if(!expected.equals(observed))throw new AssertionError("Expected <"+expected+"> got <"+observed+">");
 }
 public static void main(String[] args){
   expect("فردا سه کار رو یادم بنداز","خط باز، فردا سه کار رو یادم بنداز","خط باز");
   expect("سلام","خط باز سلام","خط باز");
   expect("اوکی؟","خط باز: اوکی؟","خط باز");
   expect("what next","MIKA, what next","میکا","Mika");
   expect("فایل را نشان بده","خط باز؛ فایل را نشان بده","خط باز");
   expect("","خط باز!","خط باز");
   expect("","خط بازرسی بکن","خط باز");
   expect("","جمله بدون بیدارباش","خط باز");
   expect("ده دقیقه صبر کن","خط‌ باز ده دقیقه صبر کن","خط باز");
   System.out.println("WakeCommandExtractor: 9/9 PASS");
 }
}
