package io.entros.playintegrity

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Play Integrity standard requests. `prepare` warms a token provider once per
 * cloud project. `request` asks the provider for a token whose requestHash is
 * the caller's digest, and prepares again once if Play reports the provider
 * invalidated. Every failure rejects. The JavaScript side turns a rejection
 * into "no token", so attestation never blocks a verification.
 */
class EntrosPlayIntegrityModule : Module() {
  private val lock = Any()
  private var projectNumber: Long? = null
  private var provider: StandardIntegrityTokenProvider? = null
  private var pending: Task<StandardIntegrityTokenProvider>? = null

  private val manager: StandardIntegrityManager by lazy {
    IntegrityManagerFactory.createStandard(
      appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost(),
    )
  }

  override fun definition() = ModuleDefinition {
    Name("EntrosPlayIntegrity")

    AsyncFunction("prepare") { cloudProjectNumber: Long, promise: Promise ->
      providerFor(cloudProjectNumber, fresh = false).addOnCompleteListener { prepared ->
        if (prepared.isSuccessful) {
          promise.resolve(null)
        } else {
          reject(promise, "ERR_PLAY_INTEGRITY_PREPARE", prepared.exception)
        }
      }
    }

    AsyncFunction("request") { requestHash: String, promise: Promise ->
      val number = synchronized(lock) { projectNumber }
      if (number == null) {
        promise.reject("ERR_PLAY_INTEGRITY_NOT_PREPARED", "Call prepare before request.", null)
        return@AsyncFunction
      }
      request(number, requestHash, retried = false, promise)
    }
  }

  private fun providerFor(number: Long, fresh: Boolean): Task<StandardIntegrityTokenProvider> =
    synchronized(lock) {
      val ready = provider
      if (!fresh && ready != null && projectNumber == number) {
        return@synchronized Tasks.forResult(ready)
      }
      val inFlight = pending
      if (!fresh && inFlight != null && projectNumber == number) {
        return@synchronized inFlight
      }
      projectNumber = number
      provider = null
      val task = manager.prepareIntegrityToken(
        PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(number).build(),
      )
      pending = task
      task.addOnCompleteListener { finished ->
        synchronized(lock) {
          if (pending === finished) {
            pending = null
            if (finished.isSuccessful) provider = finished.result
          }
        }
      }
      task
    }

  private fun request(number: Long, requestHash: String, retried: Boolean, promise: Promise) {
    providerFor(number, fresh = retried).addOnCompleteListener { prepared ->
      if (!prepared.isSuccessful) {
        reject(promise, "ERR_PLAY_INTEGRITY_PREPARE", prepared.exception)
        return@addOnCompleteListener
      }
      prepared.result
        .request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
        .addOnSuccessListener { token -> promise.resolve(token.token()) }
        .addOnFailureListener { error ->
          val invalidated = error is StandardIntegrityException &&
            error.errorCode == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID
          if (invalidated && !retried) {
            request(number, requestHash, retried = true, promise)
          } else {
            reject(promise, "ERR_PLAY_INTEGRITY_REQUEST", error)
          }
        }
    }
  }

  private fun reject(promise: Promise, code: String, error: Exception?) {
    val detail = (error as? StandardIntegrityException)?.errorCode?.let { " (code $it)" } ?: ""
    promise.reject(code, "Play Integrity failed$detail.", error)
  }
}
