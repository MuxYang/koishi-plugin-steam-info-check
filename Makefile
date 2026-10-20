CXX ?= g++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra -Wpedantic -ffunction-sections -fdata-sections
LDFLAGS ?= -Wl,--gc-sections -s
LDLIBS ?= -pthread -lssl -lcrypto

TARGET ?= steam-speed
SRC ?= src/main.cpp

.PHONY: all test clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CXX) $(CXXFLAGS) -pthread -o $@ $(SRC) $(LDFLAGS) $(LDLIBS)

test: $(TARGET)
	./$(TARGET) --self-test

clean:
	rm -f $(TARGET)
