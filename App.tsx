
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { HinaUI } from './components/HinaUI.tsx';
import { MediaLibrary } from './components/vault/MediaLibrary.tsx';
import { Login } from './components/Login.tsx';
import { CallingSystem } from './components/CallingSystem.tsx';
import { useAudioHandler } from './hooks/useAudioHandler.ts';
import { db, onSnapshot, collection, addDoc, updateDoc, doc } from './firebase.ts';
import { PERSONALITIES } from './personalities.ts';

export interface LocalMedia { id: string; name: string; url: string; type: 'audio' | 'image' | 'video' | 'file'; date: string; folder?: string; cloud?: boolean; }
export interface Folder { id: string; name: string; files: LocalMedia[]; }

const tools: { functionDeclarations: FunctionDeclaration[] } = {
  functionDeclarations: [
    {
      name: 'track_live_location',
      description: 'Get user GPS coordinates and open tracking map.',
      parameters: { type: Type.OBJECT, properties: { userId: { type: Type.STRING } }, required: ['userId'] }
    },
    {
      name: 'toggle_camera',
      description: 'Open or close the camera vision feed.',
      parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, enum: ['open', 'close'] } }, required: ['action'] }
    },
    {
      name: 'switch_camera',
      description: 'Switch between front (user) and back (environment) camera.',
      parameters: { type: Type.OBJECT, properties: { facing: { type: Type.STRING, enum: ['user', 'environment'] } }, required: ['facing'] }
    }
  ]
};

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isActivated, setIsActivated] = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [hinaResponse, setHinaResponse] = useState<string>("Ready.");
  const [vaultFolders, setVaultFolders] = useState<Folder[]>([]);
  const [cloudFolders, setCloudFolders] = useState<Folder[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [personality, setPersonality] = useState<'hina' | 'alex'>('hina');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('user');
  const [activeCall, setActiveCall] = useState<any>(null);
  const [showLibrary, setShowLibrary] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const { initAudio, processOutputAudio, resumeAudio, stopOutputAudio } = useAudioHandler();

  useEffect(() => {
    if (!currentUser) return;
    updateDoc(doc(db, "users", currentUser.id), { online: true });
    
    const unsubLocal = onSnapshot(collection(db, "users", currentUser.id, "vault"), (snapshot) => {
      const files = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as LocalMedia));
      setVaultFolders(groupFiles(files));
    });
    const unsubCloud = onSnapshot(collection(db, "cloud_storage"), (snapshot) => {
      const files = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as LocalMedia));
      setCloudFolders(groupFiles(files));
    });
    const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    
    const handleUnload = () => updateDoc(doc(db, "users", currentUser.id), { online: false });
    window.addEventListener('beforeunload', handleUnload);
    
    return () => { 
      unsubLocal(); unsubCloud(); unsubUsers(); 
      handleUnload();
    };
  }, [currentUser]);

  const groupFiles = (files: LocalMedia[]) => {
    const map: Record<string, LocalMedia[]> = {};
    files.forEach(f => {
      const folder = f.folder || 'Unsorted';
      if (!map[folder]) map[folder] = [];
      map[folder].push(f);
    });
    return Object.keys(map).map(name => ({ id: name, name, files: map[name] }));
  };

  const handleToolCall = async (call: any, sessionPromise: Promise<any>) => {
    const { name, args, id } = call;
    let result = "ok";
    if (name === 'track_live_location') {
      navigator.geolocation.getCurrentPosition(pos => {
        window.open(`https://www.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}`, '_blank');
      }, () => window.open(`https://www.google.com/maps?q=28.6139,77.2090`, '_blank'));
      result = "Opening map, Boss.";
    } else if (name === 'toggle_camera') {
      setIsCameraActive(args.action === 'open');
      result = `Camera ${args.action}ed.`;
    } else if (name === 'switch_camera') {
      setCameraFacing(args.facing);
      result = `Switched to ${args.facing} camera.`;
    }
    sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id, name, response: { result } } }));
  };

  const startSession = useCallback(async (p: 'hina' | 'alex') => {
    try {
      await resumeAudio();
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const currentPersona = PERSONALITIES[p];
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => setStatus('listening'),
          onmessage: async (m: LiveServerMessage) => {
            const input = m.serverContent?.inputTranscription?.text?.toLowerCase() || "";
            
            // Seamless Switching Detection
            if ((input.includes("alex activate") || input.includes("alex ko bulao") || input.includes("activate alex")) && personality !== 'alex') {
              stopOutputAudio();
              setPersonality('alex');
              return;
            }
            if ((input.includes("hina activate") || input.includes("hina ko bulao") || input.includes("activate hina")) && personality !== 'hina') {
              stopOutputAudio();
              setPersonality('hina');
              return;
            }

            if (m.serverContent?.outputTranscription) setHinaResponse(m.serverContent.outputTranscription.text);
            if (m.toolCall) for (const fc of m.toolCall.functionCalls) handleToolCall(fc, sessionPromise);
            
            const audioData = m.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) { 
              setStatus('speaking'); 
              await processOutputAudio(audioData); 
              setStatus('listening'); 
            }
          },
          onerror: () => setIsActivated(false),
          onclose: () => { if (isActivated) startSession(personality); else setIsActivated(false); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: currentPersona.instruction(currentUser?.name || "Amin"),
          tools: [tools],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: currentPersona.voice as any } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionRef.current = await sessionPromise;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await initAudio(stream, (blob) => { sessionPromise.then(s => s.sendRealtimeInput({ media: blob })); }, () => {});

      if (isCameraActive) {
        // Separate stream for camera if active
        const videoStream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: cameraFacing === 'user' ? "user" : "environment" } 
        });
        if (videoRef.current) videoRef.current.srcObject = videoStream;

        frameIntervalRef.current = window.setInterval(() => {
          if (videoRef.current && canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            canvasRef.current.width = 320; canvasRef.current.height = 240;
            ctx?.drawImage(videoRef.current, 0, 0, 320, 240);
            const data = canvasRef.current.toDataURL('image/jpeg', 0.5).split(',')[1];
            sessionPromise.then(s => s.sendRealtimeInput({ media: { data, mimeType: 'image/jpeg' } }));
          }
        }, 1500);
      }
    } catch (err) { setIsActivated(false); }
  }, [currentUser, isCameraActive, cameraFacing, personality, initAudio, processOutputAudio, resumeAudio]);

  useEffect(() => { 
    if (isActivated) { 
      if (sessionRef.current) sessionRef.current.close();
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current); 
      startSession(personality); 
    } 
  }, [personality, isCameraActive, cameraFacing]);

  return (
    <div className={`relative w-full h-screen overflow-hidden flex font-outfit transition-colors duration-1000 ${personality === 'alex' ? 'bg-[#1a0505]' : 'bg-black'}`}>
      <canvas ref={canvasRef} className="hidden" />
      {!currentUser ? ( <Login onLogin={setCurrentUser} /> ) : (
        <>
          <HinaUI 
            isActivated={isActivated} status={status} personality={personality} onTogglePersonality={() => setPersonality(p => p === 'hina' ? 'alex' : 'hina')}
            onToggle={() => { if (!isActivated) { setIsActivated(true); startSession(personality); } else { setIsActivated(false); sessionRef.current?.close(); stopOutputAudio(); if(frameIntervalRef.current) clearInterval(frameIntervalRef.current); if(videoRef.current?.srcObject) (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop()); } }}
            hinaResponse={hinaResponse} onToggleLibrary={() => setShowLibrary(true)} onLogout={() => { localStorage.clear(); window.location.reload(); }}
            videoRef={videoRef} user={currentUser} micLevel={0} isCameraActive={isCameraActive} 
            onCameraToggle={() => setIsCameraActive(!isCameraActive)} onCameraSwitch={() => setCameraFacing(f => f === 'user' ? 'environment' : 'user')}
          />
          {activeCall && <CallingSystem {...activeCall} onEnd={() => setActiveCall(null)} onAccept={() => setActiveCall(null)} />}
          {showLibrary && <MediaLibrary localFolders={vaultFolders} cloudFolders={cloudFolders} currentUser={currentUser} usersList={users} onClose={() => setShowLibrary(false)} onInitiateCall={(u, t) => setActiveCall({ targetName: u.name, type: t, incoming: false, callerRole: u.role })} />}
        </>
      )}
    </div>
  );
};
export default App;
