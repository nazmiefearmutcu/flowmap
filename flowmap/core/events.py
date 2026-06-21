"""Event Bus — decoupled pub/sub for application events.

Sigara yakmadan (without firing up QObject signals) lets components
communicate through a central event bus. Each event is a typed dataclass.
"""
import threading
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Callable, Any
from collections import defaultdict

try:
    from PyQt6.QtCore import QCoreApplication, QObject, pyqtSignal, pyqtSlot
    HAS_PYQT = True
except ImportError:
    HAS_PYQT = False

class EventType(Enum):
    SOURCE_CHANGED = auto()
    SIMULATION_STARTED = auto()
    SIMULATION_STOPPED = auto()
    SYMBOL_CHANGED = auto()
    DECAY_CHANGED = auto()
    ZOOM_CHANGED = auto()
    PROVIDER_CONNECTED = auto()
    PROVIDER_DISCONNECTED = auto()
    ERROR = auto()

@dataclass
class Event:
    type: EventType
    data: dict = field(default_factory=dict)

if HAS_PYQT:
    class MainThreadDispatcher(QObject):
        dispatch_signal = pyqtSignal(object)
        
        def __init__(self):
            super().__init__()
            self.dispatch_signal.connect(self._handle_dispatch)
            
        @pyqtSlot(object)
        def _handle_dispatch(self, task):
            try:
                task()
            except Exception:
                pass
else:
    MainThreadDispatcher = None

class EventBus:
    """Simple pub/sub event bus with thread safety and zero-latency GUI dispatching.
    
    Usage:
        bus = EventBus()
        bus.subscribe(EventType.SOURCE_CHANGED, lambda e: print(e.data))
        bus.publish(Event(EventType.SOURCE_CHANGED, {'source': 'SIM'}))
    """
    def __init__(self):
        self._subscribers: dict[EventType, list[tuple[Callable, bool]]] = defaultdict(list)
        self._lock = threading.RLock()
        self._dispatcher = None
        self._main_thread = threading.main_thread()
        
        # Try to initialize the dispatcher immediately if we are on the main thread
        if HAS_PYQT and threading.current_thread() == self._main_thread:
            try:
                self._dispatcher = MainThreadDispatcher()
            except Exception:
                pass

    def _get_dispatcher(self) -> Any:
        if self._dispatcher is not None:
            return self._dispatcher
        if HAS_PYQT and threading.current_thread() == self._main_thread:
            try:
                self._dispatcher = MainThreadDispatcher()
            except Exception:
                pass
        return self._dispatcher

    def subscribe(self, event_type: EventType, handler: Callable[[Event], None], main_thread: bool | None = None) -> None:
        """Subscribe a handler to an event type.
        
        If main_thread is None, it defaults to True if subscribed from the main thread, False otherwise.
        """
        if main_thread is None:
            main_thread = (threading.current_thread() == self._main_thread)
        with self._lock:
            self._subscribers[event_type].append((handler, main_thread))
    
    def unsubscribe(self, event_type: EventType, handler: Callable[[Event], None]) -> None:
        """Unsubscribe a handler from an event type."""
        with self._lock:
            subscribers = self._subscribers[event_type]
            for item in list(subscribers):
                if item[0] == handler:
                    subscribers.remove(item)
    
    def publish(self, event: Event) -> None:
        """Publish an event to all subscribers.
        
        GUI-bound handlers (main_thread=True) will be safely dispatched to the Qt event loop
        on the main thread if published from a background thread, ensuring zero-latency non-blocking
        propagation for the publisher.
        """
        with self._lock:
            handlers = list(self._subscribers[event.type])
            
        for handler, main_thread in handlers:
            try:
                if main_thread:
                    if threading.current_thread() == self._main_thread:
                        handler(event)
                    else:
                        dispatcher = self._get_dispatcher()
                        if dispatcher is not None and QCoreApplication.instance() is not None:
                            dispatcher.dispatch_signal.emit(lambda h=handler, e=event: h(e))
                        else:
                            # Fallback if no Qt event loop is running
                            handler(event)
                else:
                    handler(event)
            except Exception:
                pass  # Don't let one broken handler crash others
    
    def clear(self) -> None:
        """Clear all subscribers."""
        with self._lock:
            self._subscribers.clear()

# Singleton instance
bus = EventBus()
