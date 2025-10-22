# Voice Cloning Education Kiosk

## Overview

This is a fullstack application designed as an educational kiosk to demonstrate the dangers of deepfake and AI voice cloning technology. The application allows users to record their voice, clone it using AI, and then engage in educational conversations about the risks and implications of such technology.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript
- **Build Tool**: Vite
- **UI Library**: Radix UI components with shadcn/ui styling system
- **Styling**: Tailwind CSS with custom CSS variables
- **State Management**: TanStack Query for server state, React hooks for local state
- **Routing**: Wouter for lightweight client-side routing

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ES modules
- **Database**: PostgreSQL with Drizzle ORM
- **Database Provider**: Neon Database (serverless PostgreSQL)
- **Session Management**: In-memory storage with interface for future database integration

### Key Components

#### Voice Processing System
- **Recording**: Browser MediaRecorder API for audio capture
- **Voice Cloning**: MiniMax API integration for AI voice generation
- **Audio Format**: WebM with Opus codec, base64 encoding for storage

#### Educational AI System
- **Conversational AI**: Google Gemini 2.5 Flash for educational responses
- **Context**: Specialized prompts focused on deepfake awareness and digital literacy
- **Language**: Korean language support for educational content

#### Data Storage
- **Sessions**: Track user sessions with consent, audio data, and cloning status
- **Messages**: Store conversation history between users and AI
- **Schema**: Drizzle schema with PostgreSQL dialect

#### UI/UX Design
- **Kiosk Interface**: Touch-friendly, large button design
- **Waveform Visualization**: Real-time audio level display during recording
- **Responsive Design**: Mobile-first approach with tablet/kiosk optimization
- **Accessibility**: Screen reader support and keyboard navigation

## Data Flow

1. **Session Creation**: User provides consent and creates new session
2. **Voice Recording**: Browser captures audio, converts to base64
3. **Voice Cloning**: Audio sent to MiniMax API for voice model creation
4. **Educational Chat**: User interacts with Gemini AI using cloned voice responses
5. **Data Persistence**: Sessions and messages stored for conversation continuity

## External Dependencies

### AI Services
- **MiniMax API**: Voice cloning and speech synthesis
- **Google Gemini API**: Conversational AI for educational content

### Database & Infrastructure
- **Neon Database**: Serverless PostgreSQL hosting
- **Drizzle Kit**: Database migrations and schema management

### UI Libraries
- **Radix UI**: Accessible component primitives
- **Tailwind CSS**: Utility-first styling framework
- **Lucide React**: Icon library

### Development Tools
- **Vite**: Fast development server and build tool
- **TypeScript**: Type safety across frontend and backend
- **ESBuild**: Production bundling for backend

## Deployment Strategy

### Development Environment
- **Concurrent Servers**: Vite dev server for frontend, Express for backend
- **Hot Reload**: Real-time updates during development
- **Environment Variables**: Separate API keys for development/production

### Production Build
- **Frontend**: Vite builds optimized static assets
- **Backend**: ESBuild creates single bundled Node.js application
- **Static Serving**: Express serves built frontend assets
- **Database**: Drizzle migrations ensure schema consistency

### Configuration Management
- **Environment Variables**: API keys, database URLs via process.env
- **Path Aliases**: TypeScript paths for clean imports
- **Build Scripts**: NPM scripts for development, building, and production

The application follows a traditional three-tier architecture with clear separation between presentation (React), business logic (Express), and data (PostgreSQL). The choice of serverless database and external AI APIs enables rapid prototyping while maintaining scalability for kiosk deployment scenarios.

## Recent Changes (January 28, 2025)

### 🔄 **BACKUP POINT - 멀티유저 완성 상태 (2025-01-28)**

**완성된 멀티유저 시스템 (심플화 작업 전 백업):**
- ✅ 완전한 멀티유저 세션 격리 및 동시 접속 지원
- ✅ MiniMax API 동시성 제어 (클로닝 2개, TTS 5개 세마포어)
- ✅ 지수 백오프 재시도 로직으로 API 안정성 확보
- ✅ Admin 토큰 보호된 관리 API 시스템
- ✅ localStorage 기반 세션 유지 및 브라우저 새로고침 복원
- ✅ 사용자 활동 추적 기반 스마트 keepalive 시스템
- ✅ 60분 TTL 기반 자동 세션 만료 및 정리
- ✅ 세션별 독립적 Voice ID 생성 (`voicedeepfake-${sessionId}-${random}`)
- ✅ MiniMax 클론 보이스 자동 삭제 (정상/비정상 종료 모두 대응)
- ✅ 타입 안전성 및 에러 핸들링 완비

**주요 아키텍처 특징:**
- 복잡한 동시성 제어로 대규모 동시 접속 지원
- 활동 기반 keepalive로 정확한 세션 생명주기 관리
- 관리자 도구로 시스템 모니터링 및 제어 가능
- localStorage로 사용자 경험 연속성 보장

---

### 🎯 **현재 진행: 키오스크 최적화 심플화**

**목표**: 키오스크 환경에 최적화된 심플한 아키텍처로 변경
- 각 탭/새로고침 = 완전히 새로운 독립 체험
- 복잡한 멀티유저 기능들 제거
- 코어 기능만 남기고 유지보수성 극대화

### Implementation Status
✓ Complete voice cloning kiosk application with 5 interactive screens
✓ MiniMax API integration for voice cloning (two-step process: file upload + voice clone)
✓ Gemini API integration for educational deepfake awareness conversations
✓ Real-time recording with waveform visualization
✓ Educational content focused on deepfake risks and voice phishing prevention

### Screen Flow
1. **Intro Screen**: Welcome message with touch-to-start interface
2. **Consent Screen**: Privacy policy and data collection consent
3. **Recording Screen**: 20-second script reading with live audio visualization
4. **Cloning Screen**: Progress indicator while MiniMax processes voice
5. **Chat Screen**: Educational conversation with AI using cloned voice responses

### API Integration Details
- **MiniMax Voice Cloning**: Uses file upload + voice clone endpoints
- **Gemini Educational AI**: Context-aware responses about deepfake dangers
- **Audio Processing**: WebM format with automatic 30-second limit
- **Real-time Features**: Waveform animation during recording

### User Experience Features
- Touch-friendly kiosk interface optimized for tablets
- Korean language throughout
- Educational focus on voice phishing and deepfake awareness
- Automatic data cleanup after session completion