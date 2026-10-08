import { createContext, useContext } from 'react'
import * as api from './api'
import * as offlineCards from './offlineCards'
import * as progress from './progress'
import * as session from './session'

/*
 * Everything the study pages read, write or request, in one place.
 *
 * The app uses the real implementations below. The landing page's live demo
 * provides an in-memory sandbox instead, so the same components can run with
 * no network requests and no browser storage access.
 */
export type DataSource = {
  sandboxed: boolean

  // Local device data
  getStudentId: typeof session.getStudentId
  loadNotebook: typeof session.loadNotebook
  saveNotebook: typeof session.saveNotebook
  onNotebookChange: typeof session.onNotebookChange
  loadAvatar: typeof session.loadAvatar
  saveAvatar: typeof session.saveAvatar
  loadUnitAttempts: typeof progress.loadUnitAttempts
  recordUnitAttempt: typeof progress.recordUnitAttempt

  // Server data
  getProgress: typeof api.getProgress
  getCachedProgress: typeof api.getCachedProgress
  getAccountProfile: typeof api.getAccountProfile
  getCachedProfile: typeof api.getCachedProfile
  getFriends: typeof api.getFriends
  getCachedFriends: typeof api.getCachedFriends
  getStudyGroups: typeof api.getStudyGroups
  getCachedStudyGroups: typeof api.getCachedStudyGroups
  getTasks: typeof api.getTasks
  getCachedTasks: typeof api.getCachedTasks
  listNotes: typeof api.listNotes
  listFlashcards: typeof api.listFlashcards
  generateNoteFlashcards: typeof api.generateNoteFlashcards
  remakeNoteFlashcards: typeof api.remakeNoteFlashcards
  generateQuestion: typeof api.generateQuestion
  analyzeAnswer: typeof api.analyzeAnswer
  uploadNote: typeof api.uploadNote
  deleteNote: typeof api.deleteNote
  moveNotes: typeof api.moveNotes
  answerFriendRequest: typeof api.answerFriendRequest
  blockSocialUser: typeof api.blockSocialUser
  createStudyGroup: typeof api.createStudyGroup
  joinStudyGroup: typeof api.joinStudyGroup
  leaveStudyGroup: typeof api.leaveStudyGroup
  reactToActivity: typeof api.reactToActivity
  readSocialNotifications: typeof api.readSocialNotifications
  removeFriend: typeof api.removeFriend
  reportSocialUser: typeof api.reportSocialUser
  saveSocialPrivacy: typeof api.saveSocialPrivacy
  searchFriends: typeof api.searchFriends
  sendFriendRequest: typeof api.sendFriendRequest
  startFriendQuest: typeof api.startFriendQuest

  // Environment
  now: () => number
  hourOf: (timestamp: number) => number
  confirm: (message: string) => boolean

  // Server data (added later)
  listNoteScopes: typeof api.listNoteScopes
  // Study group ownership (owner only)
  deleteStudyGroup: typeof api.deleteStudyGroup
  transferStudyGroup: typeof api.transferStudyGroup
  // Account (Settings). Always locked in the demo.
  deleteAccount: typeof api.deleteAccount
  // Spaced-repetition review (in memory in the demo)
  getReviewSummary: typeof api.getReviewSummary
  getReviewQueue: typeof api.getReviewQueue
  gradeReviewCard: typeof api.gradeReviewCard
  // Flashcards kept on this device for offline study (IndexedDB). The demo keeps none.
  saveOfflineCards: typeof offlineCards.saveOfflineCards
  loadOfflineCards: typeof offlineCards.loadOfflineCards
  // Practice tests. The demo runs them in memory.
  createPracticeTest: typeof api.createPracticeTest
  getPracticeTest: typeof api.getPracticeTest
  submitPracticeTest: typeof api.submitPracticeTest
  listPracticeTests: typeof api.listPracticeTests
  // Friend streak reminder (in-app only). Locked in the demo.
  nudgeFriend: typeof api.nudgeFriend
}

export const realData: DataSource = {
  sandboxed: false,
  getStudentId: session.getStudentId,
  loadNotebook: session.loadNotebook,
  saveNotebook: session.saveNotebook,
  onNotebookChange: session.onNotebookChange,
  loadAvatar: session.loadAvatar,
  saveAvatar: session.saveAvatar,
  loadUnitAttempts: progress.loadUnitAttempts,
  recordUnitAttempt: progress.recordUnitAttempt,
  getProgress: api.getProgress,
  getCachedProgress: api.getCachedProgress,
  getAccountProfile: api.getAccountProfile,
  getCachedProfile: api.getCachedProfile,
  getFriends: api.getFriends,
  getCachedFriends: api.getCachedFriends,
  getStudyGroups: api.getStudyGroups,
  getCachedStudyGroups: api.getCachedStudyGroups,
  getTasks: api.getTasks,
  getCachedTasks: api.getCachedTasks,
  listNotes: api.listNotes,
  listFlashcards: api.listFlashcards,
  generateNoteFlashcards: api.generateNoteFlashcards,
  remakeNoteFlashcards: api.remakeNoteFlashcards,
  generateQuestion: api.generateQuestion,
  analyzeAnswer: api.analyzeAnswer,
  uploadNote: api.uploadNote,
  deleteNote: api.deleteNote,
  moveNotes: api.moveNotes,
  answerFriendRequest: api.answerFriendRequest,
  blockSocialUser: api.blockSocialUser,
  createStudyGroup: api.createStudyGroup,
  joinStudyGroup: api.joinStudyGroup,
  leaveStudyGroup: api.leaveStudyGroup,
  reactToActivity: api.reactToActivity,
  readSocialNotifications: api.readSocialNotifications,
  removeFriend: api.removeFriend,
  reportSocialUser: api.reportSocialUser,
  saveSocialPrivacy: api.saveSocialPrivacy,
  searchFriends: api.searchFriends,
  sendFriendRequest: api.sendFriendRequest,
  startFriendQuest: api.startFriendQuest,
  now: () => Date.now(),
  hourOf: (timestamp) => new Date(timestamp).getHours(),
  confirm: (message) => window.confirm(message),
  listNoteScopes: api.listNoteScopes,
  deleteStudyGroup: api.deleteStudyGroup,
  transferStudyGroup: api.transferStudyGroup,
  deleteAccount: api.deleteAccount,
  getReviewSummary: api.getReviewSummary,
  getReviewQueue: api.getReviewQueue,
  gradeReviewCard: api.gradeReviewCard,
  saveOfflineCards: offlineCards.saveOfflineCards,
  loadOfflineCards: offlineCards.loadOfflineCards,
  createPracticeTest: api.createPracticeTest,
  getPracticeTest: api.getPracticeTest,
  submitPracticeTest: api.submitPracticeTest,
  listPracticeTests: api.listPracticeTests,
  nudgeFriend: api.nudgeFriend,
}

const DataContext = createContext<DataSource>(realData)

export const DataProvider = DataContext.Provider

export function useData(): DataSource {
  return useContext(DataContext)
}
