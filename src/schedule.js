import { chromium } from "playwright"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  getNextDay,
  loadLastMessage,
  saveLastMessage,
  deleteLastMessage,
  useSchedule,
} from "./helpers.js"
import {
  DayTitle,
  GROUP,
  hours,
  PowerState,
  SHUTDOWNS_DATA_MATCHER,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
} from "./constants.js"

const getShutdownsData = async ({ attempt = 0 } = {}) => {
  console.log("🌀 Getting shutdowns data...")

  const browser = await chromium.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error("not found")
    }

    const data = JSON.parse(match[1])
    console.log("✅ Getting shutdowns data finished.")
    return data
  } catch (error) {
    console.error(`❌ Getting shutdowns data failed: ${error.message}.`)
  } finally {
    await browser.close()
  }

  if (attempt < RETRIES_MAX_COUNT) {
    console.log("🌀 Try getting shutdowns data again...")
    await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
    return await getShutdownsData({ attempt: attempt + 1 })
  }

  throw Error(
    `❌ Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

function generateSchedule({ data }) {
  if (!data) return null

  console.log("🌀 Generating schedule...")

  try {
    const [schedule, setSchedule] = useSchedule([])

    hours.forEach((hour) => {
      const state = data[hour + 1]

      switch (state) {
        case PowerState.ON:
          setSchedule(createPeriod({ hour, power: true }))
          break

        case PowerState.OFF:
          setSchedule(createPeriod({ hour, power: false }))
          break

        case PowerState.HALF_ON:
          setSchedule(createPeriod({ hour, endMin: 30, power: true }))
          setSchedule(createPeriod({ hour, startMin: 30, power: false }))
          break

        case PowerState.HALF_OFF:
          setSchedule(createPeriod({ hour, endMin: 30, power: false }))
          setSchedule(createPeriod({ hour, startMin: 30, power: true }))
          break
      }
    })

    console.log("✅ Generating schedule finished.")

    return schedule
  } catch (error) {
    throw Error(`❌ Generating schedule failed: ${error.message}.`)
  }
}

function parseDayToDate(dayValue) {
  if (!dayValue && dayValue !== 0) return null

  if (typeof dayValue === "number") {
    const ms = dayValue < 1e12 ? dayValue * 1000 : dayValue
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const str = String(dayValue).trim()

  if (/^\d+$/.test(str)) {
    const num = Number(str)
    const ms = num < 1e12 ? num * 1000 : num
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const dmyMatch = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  if (dmyMatch) {
    const [, dd, mm, yyyy] = dmyMatch
    const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 12))
    return Number.isNaN(date.getTime()) ? null : date
  }

  const ymdMatch = str.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
  if (ymdMatch) {
    const [, yyyy, mm, dd] = ymdMatch
    const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 12))
    return Number.isNaN(date.getTime()) ? null : date
  }

  const parsed = new Date(str)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatDayHeading({ title, dayValue }) {
  const date = parseDayToDate(dayValue)
  if (!date) return title

  const timeZone = "Europe/Kyiv"
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    weekday: "long",
  }).formatToParts(date)

  const getPart = (type) => parts.find((p) => p.type === type)?.value || ""
  const dd = getPart("day")
  const mm = getPart("month")
  const yyyy = getPart("year")
  const weekdayRaw = getPart("weekday")
  const weekday = weekdayRaw
    ? weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1)
    : ""

  if (!dd || !mm || !yyyy) return title

  return weekday
    ? `${title}, ${dd}.${mm}.${yyyy} (${weekday})`
    : `${title}, ${dd}.${mm}.${yyyy}`
}

function parseTimeToMinutes(timeStr) {
  const [hh, mm] = String(timeStr).split(":").map(Number)
  return hh * 60 + mm
}

function getPeriodMinutes(begin, end) {
  const start = parseTimeToMinutes(begin)
  let finish = parseTimeToMinutes(end)
  if (finish <= start) {
    finish += 24 * 60
  }
  return Math.max(0, finish - start)
}

function formatHoursShort(minutes) {
  const hours = minutes / 60
  const formatted = Number.isInteger(hours)
    ? String(hours)
    : String(Number(hours.toFixed(1)))
  return `${formatted} ч`
}

function formatTotalDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) return `${hours} ч`
  if (hours === 0) return `${minutes} мин`
  return `${hours} ч ${minutes} мин`
}

function generateScheduleText({ title, dayValue, schedule }) {
  if (!schedule) return null

  const heading = formatDayHeading({ title, dayValue })
  const offPeriods = schedule.filter(({ power }) => !power)
  const isShutdownsExists = offPeriods.length > 0

  isShutdownsExists
    ? console.log(`Power shutdowns detected: ${heading}.`)
    : console.log(`No power shutdowns: ${heading}.`)

  if (!isShutdownsExists) {
    const periods = schedule.map(
      ({ begin, end }) => `<code>${begin} — ${end}</code>`
    )
    return [`<b>${heading}:</b>`, ...periods].join("\n")
  }

  let totalOffMinutes = 0

  const periods = offPeriods.map(({ begin, end }) => {
    const durationMin = getPeriodMinutes(begin, end)
    totalOffMinutes += durationMin
    const approxHours = formatHoursShort(durationMin)
    return `<code>${begin} — ${end}</code> (~${approxHours})`
  })

  return [
    `<b>${heading}:</b>`,
    ...periods,
    `Всего без света: ${formatTotalDuration(totalOffMinutes)}`,
  ].join("\n")
}

function generateMessage({ sections, updatedAt }) {
  console.log("🌀 Generating message...")

  const body = sections.filter(Boolean).join("\n\n")

  const footer = [
    `📢 <i>${updatedAt}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ].join("\n")

  return { body, footer }
}

async function sendNotification({ body, footer, attempt = 0 }) {
  if (!TELEGRAM_BOT_TOKEN) throw Error("❌ Missing telegram bot token.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  const chatIds = String(TELEGRAM_CHAT_ID)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)

  if (!chatIds.length) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")

  const text = [body, footer].join("\n\n")
  const lastState = loadLastMessage()
  const isMapState =
    lastState &&
    typeof lastState === "object" &&
    !Array.isArray(lastState) &&
    lastState.chats &&
    typeof lastState.chats === "object"

  const nextState = {
    body,
    chats: isMapState ? { ...lastState.chats } : {},
  }

  // Если раньше сохранялся формат под один чат — перенесём его на первый ID
  if (!isMapState && lastState?.message_id && chatIds[0]) {
    nextState.chats[chatIds[0]] = {
      message_id: lastState.message_id,
      body: lastState.body,
    }
  }

  try {
    let anySentOrUpdated = false

    for (const chatId of chatIds) {
      const prevChat = nextState.chats[chatId] || {}
      const isBodyChanged = prevChat.body !== body
      const isEdit = Boolean(prevChat.message_id) && !isBodyChanged
      const isReply = Boolean(prevChat.message_id) && isBodyChanged

      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${
          isEdit ? "editMessageText" : "sendMessage"
        }`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_notification: checkIsNight(),
            message_id: isEdit ? prevChat.message_id : undefined,
            reply_parameters: isReply
              ? {
                  message_id: prevChat.message_id,
                  allow_sending_without_reply: true,
                }
              : undefined,
          }),
        }
      )

      const data = await response.json()

      if (data.description?.includes("not modified")) {
        console.log(`🟡 Notification not changed (${chatId}).`)
        continue
      }

      if (!data.ok) {
        delete nextState.chats[chatId]
        throw Error(`[${chatId}] ${data.description}`)
      }

      nextState.chats[chatId] = {
        message_id: data.result.message_id,
        body,
      }
      anySentOrUpdated = true
      console.log(`🟢 Notification sent (${chatId}).`)
    }

    if (anySentOrUpdated) {
      saveLastMessage(nextState)
    }
  } catch (error) {
    console.error(`❌ Sending notification failed: ${error.message}.`)

    if (attempt < RETRIES_MAX_COUNT) {
      console.log("🌀 Try sending notification again...")
      await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
      return await sendNotification({
        body,
        footer,
        attempt: attempt + 1,
      })
    }

    throw Error(
      `❌ Sending notification failed after ${RETRIES_MAX_COUNT} retries.`
    )
  }
}

async function run() {
  const data = await getShutdownsData()

  const { today } = data
  const tomorrow = getNextDay({ data, day: today })

  const todayData = data.data?.[today]?.[GROUP]
  const tomorrowData = data.data?.[tomorrow]?.[GROUP]

  const todaySchedule = generateSchedule({ data: todayData })
  const tomorrowSchedule = generateSchedule({ data: tomorrowData })

  console.log("Debug data:", {
    today,
    tomorrow,
    group: GROUP,
    dataKeys: Object.keys(data.data || {}),
    groupKeys: Object.keys(data.data?.[today] || {}),
  })

  if (!todaySchedule && !tomorrowSchedule) {
    console.log("🔋 No schedule.")
    return
  }

  const todayText = generateScheduleText({
    title: DayTitle.TODAY,
    dayValue: today,
    schedule: todaySchedule,
  })
  const tomorrowText = generateScheduleText({
    title: DayTitle.TOMORROW,
    dayValue: tomorrow,
    schedule: tomorrowSchedule,
  })

  const message = generateMessage({
    sections: [todayText, tomorrowText],
    updatedAt: data.update,
  })

  await sendNotification(message)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
