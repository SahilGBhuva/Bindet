import { createContext, useContext } from 'react'
import * as api from './api'
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
  generateFlashcards: typeof api.generateFlashcards
  generateQuestion: typeof api.generateQuestion
  analyzeAnswer: typeof api.analyzeAnswer
  uploadNote: typeof api.uploadNote
  deleteNote: typeof api.deleteNote
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
}

export const realData: DataSource = {
  sandboxed: false,
  getStudentId: session.getStudentId,
  loadNotebook: session.loadNotebook,
  saveNotebook: session.saveNotebook,
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
  generateFlashcards: api.generateFlashcards,
  generateQuestion: api.generateQuestion,
  analyzeAnswer: api.analyzeAnswer,
  uploadNote: api.uploadNote,
  deleteNote: api.deleteNote,
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
}

const DataContext = createContext<DataSource>(realData)

export const DataProvider = DataContext.Provider

export function useData(): DataSource {
  return useContext(DataContext)
}
