// Full-screen "alarm clock" takeover for urgent cards. Android only; null anywhere else
// (and on older app builds that don't include the native code).
import { requireOptionalNativeModule } from "expo";
export default requireOptionalNativeModule("Takeover");
