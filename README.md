# VedaAI Assessment Creator

An AI-powered question paper generator built with React + Vite. Teachers and educators can define assignment parameters (subject, topic, grade, question types, difficulty levels) and the app generates a complete, structured question paper using an LLM via the OpenRouter API.

![React](https://img.shields.io/badge/React-18.x-61dafb?logo=react)
![Vite](https://img.shields.io/badge/Vite-5.x-646cff?logo=vite)
![OpenRouter](https://img.shields.io/badge/OpenRouter-API-ff6b35)

---

## Table of Contents

- [Features](#features)
- [Architecture & Flow](#architecture--flow)
- [AI Model](#ai-model)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Running the App](#running-the-app)
- [How It Works](#how-it-works)
  - [Step 1: Create Assignment](#step-1-create-assignment)
  - [Step 2: AI Generation](#step-2-ai-generation)
  - [Step 3: Question Paper Output](#step-3-question-paper-output)
- [Fallback Mechanism](#fallback-mechanism)
- [Print Support](#print-support)
- [License](#license)

---

## Features

- **Assignment Configuration Form** — Define subject, topic/chapter, grade/class, duration, total marks, due date, and additional instructions.
- **Dynamic Question Type Builder** — Add multiple question types (MCQ, Short Answer, Long Answer, True/False, Fill in the blank, Match the following) with count, marks per question, and difficulty level.
- **AI-Powered Paper Generation** — Sends a structured prompt to an LLM via OpenRouter to generate a complete, realistic question paper.
- **Simulated WebSocket Progress** — Real-time job progress simulation showing each backend step (queue → processing → LLM call → parsing → storing → caching).
- **Structured Paper Output** — Generated paper includes sections (A/B/C by difficulty), general instructions, student info fields, and per-question metadata (difficulty badge, marks, type).
- **Fallback Mock Paper** — If the API key is missing or the API call fails, a deterministic mock paper is generated locally.
- **Print-Friendly** — Clean print stylesheet that hides UI chrome and shows only the paper.
- **Responsive Design** — Fully responsive layout with a warm, academic aesthetic (Lora + Outfit fonts, gold/teal color palette).

---

## Architecture & Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React + Vite)                      │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Step 1:      │    │  Step 2:          │    │  Step 3:         │  │
│  │  Create       │───▶│  AI Generation    │───▶│  Question Paper  │  │
│  │  Assignment   │    │  (Progress Sim)   │    │  Output          │  │
│  └──────────────┘    └──────────────────┘    └──────────────────┘  │
│         │                     │                       │             │
│         ▼                     ▼                       ▼             │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Form State   │    │  simulateWS()    │    │  Paper Preview   │  │
│  │  + Validation │    │  (WebSocket sim) │    │  + Print         │  │
│  └──────────────┘    └──────────────────┘    └──────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│                   ┌──────────────────────┐                         │
│                   │  generatePaper()     │                         │
│                   │  ┌─────────────────┐ │                         │
│                   │  │ OpenRouter API  │ │                         │
│                   │  │ (LLM call)      │ │                         │
│                   │  └────────┬────────┘ │                         │
│                   │           │          │                         │
│                   │     ┌─────┴─────┐    │                         │
│                   │     │           │    │                         │
│                   │  Success     Failure │                         │
│                   │     │           │    │                         │
│                   │     ▼           ▼    │                         │
│                   │  Parse &    mockPaper│                         │
│                   │  Validate   ()       │                         │
│                   └──────────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Application Flow

1. **User fills the assignment form** — subject, topic, grade, duration, total marks, question types with counts/marks/difficulty.
2. **Client-side validation** ensures all required fields are filled and question counts/marks are positive.
3. **On submit**, the app transitions to the "AI Generation" step and starts a **simulated WebSocket progress sequence** that mimics a real backend pipeline:
   - Job queued in BullMQ (Redis-backed)
   - Worker process picks up the job
   - Structured prompt is built from assignment config
   - OpenRouter API is called with the LLM
   - Response is received and JSON schema is validated
   - Questions are parsed and structured into sections
   - Result is stored in MongoDB
   - Result is cached in Redis (TTL 1h)
   - Job complete — frontend is notified
4. **`generatePaper()`** is called, which:
   - Checks for `VITE_OPENROUTER_API_KEY` in environment variables
   - If the key exists, sends a carefully crafted prompt to the OpenRouter API
   - Parses the JSON response and validates the schema
   - If the key is missing or any error occurs, falls back to `mockPaper()` which generates a deterministic paper locally
5. **The generated paper** is displayed in a beautifully formatted, print-ready layout with sections, difficulty badges, and marks.

---

## AI Model

The app uses **[nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free](https://openrouter.ai/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free)** via the [OpenRouter API](https://openrouter.ai/).

| Property | Value |
|----------|-------|
| **Model** | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| **Provider** | OpenRouter |
| **Tier** | Free |
| **Type** | Reasoning / Text Generation |
| **Use Case** | Structured JSON question paper generation |

The prompt engineering includes:
- Assignment metadata (subject, topic, grade, duration, total marks)
- Question type breakdown (count, type, marks each, difficulty)
- Teacher instructions
- Strict JSON schema requirements
- Rules for difficulty ordering (Section A = Easy, Section B = Moderate, Section C = Hard)
- Variation seed support for generating different papers on regeneration

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | React 18.x |
| **Build Tool** | Vite 5.x |
| **Styling** | CSS-in-JS (inline `<style>` tag) |
| **State Management** | Custom lightweight store (Zustand-style) |
| **AI API** | OpenRouter (REST) |
| **Fonts** | Lora (serif), Outfit (sans-serif), JetBrains Mono (monospace) |
| **Icons** | Inline SVG components |

---

## Project Structure

```
vedaai-assessment-creator/
├── index.html                  # Entry HTML with VedaAI branding
├── package.json                # Dependencies & scripts
├── vite.config.js              # Vite configuration
├── .env.example                # Environment variable template
├── .gitignore                  # Git ignore rules
├── README.md                   # This file
└── src/
    ├── main.jsx                # React entry point (ReactDOM.createRoot)
    └── App.jsx                 # Main application component
                                #  - Custom store (createStore)
                                #  - WebSocket simulator (simulateWS)
                                #  - Prompt builder (buildPrompt)
                                #  - Schema validation (validatePaperSchema)
                                #  - Mock paper generator (mockPaper)
                                #  - AI paper generator (generatePaper)
                                #  - SVG icon components (Ic.*)
                                #  - All UI components (StepBar, CreateForm, etc.)
                                #  - All CSS styles
```

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18.x
- **npm** ≥ 9.x
- An [OpenRouter](https://openrouter.ai/) API key (free tier works)

### Installation

```bash
cd vedaai-assessment-creator
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` and add your OpenRouter API key:

```
VITE_OPENROUTER_API_KEY=your_openrouter_api_key_here
```

> **Note:** The `VITE_` prefix is required for Vite to expose the variable to the client-side code via `import.meta.env`.

### Running the App

```bash
npm run dev
```

The app will be available at `http://localhost:5173`.

Other available scripts:

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build locally |

---

## How It Works

### Step 1: Create Assignment

The user fills out a comprehensive form:

- **Subject** — e.g., Mathematics, Science, English
- **Grade/Class** — e.g., Class 10, Grade 12
- **Topic/Chapter** — e.g., Quadratic Equations, Photosynthesis
- **Duration** — Exam duration in minutes
- **Total Marks** — Total marks for the paper
- **Due Date** — Optional deadline
- **Additional Instructions** — Free-text teacher instructions
- **Question Types** — Dynamic table where the user adds rows for each question type:
  - Type (MCQ, Short Answer, Long Answer, True/False, Fill in the blank, Match the following)
  - Count (number of questions)
  - Marks per question
  - Difficulty (Easy, Moderate, Hard, Mixed)

Client-side validation ensures all required fields are filled before submission.

### Step 2: AI Generation

After submission, the app shows an animated generation screen with:

- A spinning gradient ring animation
- A **simulated WebSocket terminal** showing real-time progress messages
- A progress bar with percentage

The simulation runs through 9 stages over ~8.4 seconds, mimicking a real backend pipeline (BullMQ → Worker → Prompt Build → LLM Call → Validation → Parsing → MongoDB → Redis Cache → Done).

### Step 3: Question Paper Output

The generated paper is displayed in a beautifully formatted layout:

- **School header** with decorative branding
- **Paper title** (auto-generated from topic)
- **Metadata grid** — Subject, Grade, Duration, Total Marks
- **Student info fields** — Name, Class, Roll No, Date
- **General instructions** — Standard exam rules
- **Sections (A, B, C)** — Grouped by difficulty:
  - Section A: Easy questions
  - Section B: Moderate questions
  - Section C: Hard/Long-answer questions
- **Per-question metadata** — Difficulty badge (color-coded), question type tag, marks
- **Action bar** — Regenerate button, download indicator, model info

---

## Fallback Mechanism

If the OpenRouter API key is missing or the API call fails for any reason (network error, invalid response, schema validation failure), the app automatically falls back to a **deterministic mock paper generator** (`mockPaper()`):

- Questions are generated based on the assignment configuration
- Difficulty is mapped to sections (Easy → A, Moderate → B, Hard → C)
- Marks are calculated from the question type configuration
- General instructions are standardized

This ensures the app is always functional for demonstration purposes, even without an API key.

---

## Print Support

The app includes a dedicated print stylesheet. Use the browser's **Print** function (Ctrl/Cmd + P) to get a clean, paper-ready PDF:

- Header, step bar, and action buttons are hidden
- Only the question paper is shown
- Optimized typography and spacing for A4 paper

---

## License

This project is for educational and demonstration purposes.
# Vedaai-Assignment
