package com.lionpocketmobile

import android.app.DatePickerDialog
import android.content.res.Configuration
import android.view.ContextThemeWrapper
import android.widget.TextView
import com.facebook.react.bridge.*
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import java.util.Calendar
import java.util.Locale
import java.text.SimpleDateFormat

class LocalUiModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "LionPocketUi"
  private var dialog: DatePickerDialog? = null
  private var pending: Promise? = null

  @ReactMethod fun pickDate(value: String, light: Boolean, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) { promise.reject("DATE_PICKER", "Calendário indisponível."); return }
    activity.runOnUiThread {
      if (pending != null) { promise.reject("DATE_PICKER", "O calendário já está aberto."); return@runOnUiThread }
      try {
        val parts = value.split('-').map { it.toInt() }
        require(parts.size == 3 && parts[0] in 1000..9999 && parts[1] in 1..12 && parts[2] in 1..31)
        val theme = if (light) R.style.LionPocketDatePickerLight else R.style.LionPocketDatePickerDark
        val localized = ContextThemeWrapper(activity, theme).apply {
          applyOverrideConfiguration(Configuration(activity.resources.configuration).apply {
            setLocale(Locale("pt", "BR"))
          })
        }
        pending = promise
        dialog = DatePickerDialog(localized, theme, { _, year, month, day ->
          pending?.resolve(String.format(Locale.ROOT, "%04d-%02d-%02d", year, month + 1, day))
          pending = null
        }, parts[0], parts[1] - 1, parts[2]).apply {
          datePicker.minDate = Calendar.getInstance().apply { set(1000, 0, 1, 0, 0, 0) }.timeInMillis
          datePicker.maxDate = Calendar.getInstance().apply { set(9999, 11, 31, 23, 59, 59) }.timeInMillis
          // Some Android calendar headers use the process locale instead of the
          // dialog configuration. Keep their label in the app's Portuguese.
          fun localizeHeader(year: Int, month: Int, day: Int) {
            datePicker.post {
              val id = datePicker.resources.getIdentifier("date_picker_header_date", "id", "android")
              datePicker.findViewById<TextView>(id)?.text = SimpleDateFormat("EEE, d MMM", Locale("pt", "BR"))
                .format(Calendar.getInstance().apply { set(year, month, day) }.time)
            }
          }
          datePicker.init(parts[0], parts[1] - 1, parts[2]) { view, year, month, day ->
            onDateChanged(view, year, month, day)
            localizeHeader(year, month, day)
          }
          setOnDismissListener { pending?.resolve(null); pending = null; dialog = null }
          show()
          localizeHeader(parts[0], parts[1] - 1, parts[2])
        }
      } catch (error: Exception) { pending = null; promise.reject("DATE_PICKER", error.message, error) }
    }
  }
  override fun invalidate() {
    reactApplicationContext.runOnUiQueueThread { dialog?.dismiss(); dialog = null; pending = null }
    super.invalidate()
  }
}
class LocalUiPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(LocalUiModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
