import { Router } from "express";
import { VoiceController } from "../controllers/voice.controller";
import express from "express";

const voiceRoute = Router();

// Voice session management
voiceRoute.post("/session/start", VoiceController.start);
voiceRoute.post("/session/stop", VoiceController.stop);
voiceRoute.post("/audio", VoiceController.sendAudio);
voiceRoute.get("/stream", VoiceController.stream);
voiceRoute.post("/transcribe", express.json({ limit: "50mb" }), VoiceController.transcribe);
voiceRoute.post("/tts", express.json({ limit: "1mb" }), VoiceController.tts);

export { voiceRoute };

