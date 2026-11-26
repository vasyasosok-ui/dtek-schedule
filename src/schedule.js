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
  return `${formatted} год`
}

function formatTotalDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) return `${hours} год`
  if (hours === 0) return `${minutes} хв`
  return `${hours} год ${minutes} хв`
}

function generateScheduleText({ title, schedule }) {
  if (!schedule) return null

  const offPeriods = schedule.filter(({ power }) => !power)
  const isShutdownsExists = offPeriods.length > 0

  isShutdownsExists
    ? console.log(`Power shutdowns detected: ${title}.`)
    : console.log(`No power shutdowns: ${title}.`)

  if (!isShutdownsExists) {
    const periods = schedule.map(
      ({ begin, end }) => `<code>${begin} — ${end}</code>`
    )
    return [`<b>${title}:</b>`, ...periods].join("\n")
  }

  let totalOffMinutes = 0

  const periods = offPeriods.map(({ begin, end }) => {
    const durationMin = getPeriodMinutes(begin, end)
    totalOffMinutes += durationMin
    const approxHours = formatHoursShort(durationMin)
    return `<code>${begin} — ${end}</code> (~${approxHours})`
  })

  return [
    `<b>${title}:</b>`,
    ...periods,
    `Загалом без світла: ${formatTotalDuration(totalOffMinutes)}`,
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

  if (!todaySchedule && !tomorrowSchedule) {
    console.log("🔋 No schedule.")
    return
  }

  const todayText = generateScheduleText({
    title: DayTitle.TODAY,
    schedule: todaySchedule,
  })
  const tomorrowText = generateScheduleText({
    title: DayTitle.TOMORROW,
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
