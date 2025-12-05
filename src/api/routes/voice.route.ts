import { Router } from "express";
import { VoiceController } from "../controllers/voice.controller";

const voiceRoute = Router();

// Voice session management
voiceRoute.post("/session/start", VoiceController.start);
voiceRoute.post("/session/stop", VoiceController.stop);
voiceRoute.post("/audio", VoiceController.sendAudio);
voiceRoute.get("/stream", VoiceController.stream);

export { voiceRoute };

